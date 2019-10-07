/*-----------------------------------------------------------------------------
| Copyright (c) Jupyter Development Team.
| Distributed under the terms of the Modified BSD License.
|----------------------------------------------------------------------------*/

import * as fs from 'fs-extra';
import * as glob from 'glob';
import * as path from 'path';
import * as prettier from 'prettier';
import * as ts from 'typescript';
import { getDependency } from './get-dependency';
import * as utils from './utils';

const HEADER_TEMPLATE = `
/*-----------------------------------------------------------------------------
| Copyright (c) Jupyter Development Team.
| Distributed under the terms of the Modified BSD License.
|----------------------------------------------------------------------------*/

/* This file was auto-generated by {{funcName}}() in @jupyterlab/buildutils */
`;

const ICON_IMPORTS_TEMPLATE = `
import { createIcon } from './jlicon';
import { Icon } from './interfaces';

// icon svg import statements
{{iconImportStatements}}

// defaultIcons definition
export namespace IconImports {
  export const defaultIcons: ReadonlyArray<Icon.IModel> = [
    {{iconModelDeclarations}}
  ];
}

// wrapped icon definitions
{{wrappedIconDefs}}
`;

const ICON_CSS_CLASSES_TEMPLATE = `
/**
 * (DEPRECATED) Support for consuming icons as CSS background images
 */

/* Icons urls */

:root {
  {{iconCSSUrls}}
}

/* Icon CSS class declarations */

{{iconCSSDeclarations}}
`;

/**
 * Ensure the integrity of a package.
 *
 * @param options - The options used to ensure the package.
 *
 * @returns A list of changes that were made to ensure the package.
 */
export async function ensurePackage(
  options: IEnsurePackageOptions
): Promise<string[]> {
  let { data, pkgPath } = options;
  let deps: { [key: string]: string } = data.dependencies || {};
  let devDeps: { [key: string]: string } = data.devDependencies || {};
  let seenDeps = options.depCache || {};
  let missing = options.missing || [];
  let unused = options.unused || [];
  let messages: string[] = [];
  let locals = options.locals || {};
  let cssImports = options.cssImports || [];
  let differentVersions = options.differentVersions || [];

  // Verify dependencies are consistent.
  let promises = Object.keys(deps).map(async name => {
    if (differentVersions.indexOf(name) !== -1) {
      // Skip processing packages that can have different versions
      return;
    }
    if (!(name in seenDeps)) {
      seenDeps[name] = await getDependency(name);
    }
    if (deps[name] !== seenDeps[name]) {
      messages.push(`Updated dependency: ${name}@${seenDeps[name]}`);
    }
    deps[name] = seenDeps[name];
  });

  await Promise.all(promises);

  // Verify devDependencies are consistent.
  promises = Object.keys(devDeps).map(async name => {
    if (differentVersions.indexOf(name) !== -1) {
      // Skip processing packages that can have different versions
      return;
    }
    if (!(name in seenDeps)) {
      seenDeps[name] = await getDependency(name);
    }
    if (devDeps[name] !== seenDeps[name]) {
      messages.push(`Updated devDependency: ${name}@${seenDeps[name]}`);
    }
    devDeps[name] = seenDeps[name];
  });

  await Promise.all(promises);

  // For TypeScript files, verify imports match dependencies.
  let filenames: string[] = [];
  filenames = glob.sync(path.join(pkgPath, 'src/*.ts*'));
  filenames = filenames.concat(glob.sync(path.join(pkgPath, 'src/**/*.ts*')));

  if (!fs.existsSync(path.join(pkgPath, 'tsconfig.json'))) {
    if (utils.writePackageData(path.join(pkgPath, 'package.json'), data)) {
      messages.push('Updated package.json');
    }
    return messages;
  }

  // Make sure typedoc config files are consistent
  if (fs.existsSync(path.join(pkgPath, 'typedoc.json'))) {
    let name = data.name.split('/');
    utils.writeJSONFile(path.join(pkgPath, 'typedoc.json'), {
      excludeNotExported: true,
      mode: 'file',
      out: `../../docs/api/${name[name.length - 1]}`,
      theme: '../../typedoc-theme'
    });
  }

  let imports: string[] = [];

  // Extract all of the imports from the TypeScript files.
  filenames.forEach(fileName => {
    let sourceFile = ts.createSourceFile(
      fileName,
      fs.readFileSync(fileName).toString(),
      (ts.ScriptTarget as any).ES6,
      /*setParentNodes */ true
    );
    imports = imports.concat(getImports(sourceFile));
  });

  // Make sure we are not importing CSS in a core package.
  if (data.name.indexOf('example') === -1) {
    imports.forEach(importStr => {
      if (importStr.indexOf('.css') !== -1) {
        messages.push('CSS imports are not allowed source files');
      }
    });
  }

  let names: string[] = Array.from(new Set(imports)).sort();
  names = names.map(function(name) {
    let parts = name.split('/');
    if (name.indexOf('@') === 0) {
      return parts[0] + '/' + parts[1];
    }
    return parts[0];
  });

  // Look for imports with no dependencies.
  promises = names.map(async name => {
    if (missing.indexOf(name) !== -1) {
      return;
    }
    if (name === '.' || name === '..') {
      return;
    }
    if (!deps[name]) {
      if (!(name in seenDeps)) {
        seenDeps[name] = await getDependency(name);
      }
      deps[name] = seenDeps[name];
      messages.push(`Added dependency: ${name}@${seenDeps[name]}`);
    }
  });

  await Promise.all(promises);

  // Template the CSS index file.
  if (cssImports && fs.existsSync(path.join(pkgPath, 'style/base.css'))) {
    const funcName = 'ensurePackage';
    let cssIndexContents = utils.fromTemplate(
      HEADER_TEMPLATE,
      { funcName },
      { end: '' }
    );
    cssImports.forEach(cssImport => {
      cssIndexContents += `\n@import url('~${cssImport}');`;
    });
    cssIndexContents += "\n\n@import url('./base.css');\n";

    // write out cssIndexContents, if needed
    const cssIndexPath = path.join(pkgPath, 'style/index.css');
    if (!fs.existsSync(cssIndexPath)) {
      fs.ensureFileSync(cssIndexPath);
    }
    messages.push(...ensureFile(cssIndexPath, cssIndexContents, false));
  }

  // Look for unused packages
  Object.keys(deps).forEach(name => {
    if (options.noUnused === false) {
      return;
    }
    if (unused.indexOf(name) !== -1) {
      return;
    }
    const isTest = data.name.indexOf('test') !== -1;
    if (isTest) {
      const testLibs = ['jest', 'ts-jest', '@jupyterlab/testutils'];
      if (testLibs.indexOf(name) !== -1) {
        return;
      }
    }
    if (names.indexOf(name) === -1) {
      let version = data.dependencies[name];
      messages.push(
        `Unused dependency: ${name}@${version}: remove or add to list of known unused dependencies for this package`
      );
    }
  });

  // Handle typedoc config output.
  const tdOptionsPath = path.join(pkgPath, 'tdoptions.json');
  if (fs.existsSync(tdOptionsPath)) {
    const tdConfigData = utils.readJSONFile(tdOptionsPath);
    const pkgDirName = pkgPath.split('/').pop();
    tdConfigData['out'] = `../../docs/api/${pkgDirName}`;
    utils.writeJSONFile(tdOptionsPath, tdConfigData);
  }

  // Handle references.
  let references: { [key: string]: string } = Object.create(null);
  Object.keys(deps).forEach(name => {
    if (!(name in locals)) {
      return;
    }
    const target = locals[name];
    if (!fs.existsSync(path.join(target, 'tsconfig.json'))) {
      return;
    }
    let ref = path.relative(pkgPath, locals[name]);
    references[name] = ref.split(path.sep).join('/');
  });
  if (
    data.name.indexOf('example-') === -1 &&
    Object.keys(references).length > 0
  ) {
    const tsConfigPath = path.join(pkgPath, 'tsconfig.json');
    const tsConfigData = utils.readJSONFile(tsConfigPath);
    tsConfigData.references = [];
    Object.keys(references).forEach(name => {
      tsConfigData.references.push({ path: references[name] });
    });
    utils.writeJSONFile(tsConfigPath, tsConfigData);
  }

  // Get a list of all the published files.
  // This will not catch .js or .d.ts files if they have not been built,
  // but we primarily use this to check for files that are published as-is,
  // like styles, assets, and schemas.
  const published = new Set<string>(
    data.files
      ? data.files.reduce((acc: string[], curr: string) => {
          return acc.concat(glob.sync(path.join(pkgPath, curr)));
        }, [])
      : []
  );

  // Ensure that the `schema` directories match what is in the `package.json`
  const schemaDir = data.jupyterlab && data.jupyterlab.schemaDir;
  const schemas = glob.sync(
    path.join(pkgPath, schemaDir || 'schema', '*.json')
  );
  if (schemaDir && !schemas.length) {
    messages.push(`No schemas found in ${path.join(pkgPath, schemaDir)}.`);
  } else if (!schemaDir && schemas.length) {
    messages.push(`Schemas found, but no schema indicated in ${pkgPath}`);
  }
  for (let schema of schemas) {
    if (!published.has(schema)) {
      messages.push(`Schema ${schema} not published in ${pkgPath}`);
    }
  }

  // Ensure that the `style` directories match what is in the `package.json`
  const styles = glob.sync(path.join(pkgPath, 'style', '**/*.*'));
  for (let style of styles) {
    if (!published.has(style)) {
      messages.push(`Style file ${style} not published in ${pkgPath}`);
    }
  }

  // If we have styles, ensure that 'style' field is declared
  if (styles.length > 0) {
    if (data.style === undefined) {
      data.style = 'style/index.css';
    }
  }

  // Ensure that sideEffects are declared, and that any styles are covered
  if (styles.length > 0) {
    if (data.sideEffects === undefined) {
      messages.push(
        `Side effects not declared in ${pkgPath}, and styles are present.`
      );
    } else if (data.sideEffects === false) {
      messages.push(`Style files not included in sideEffects in ${pkgPath}`);
    }
  }

  // Ensure dependencies and dev dependencies.
  data.dependencies = deps;
  data.devDependencies = devDeps;

  if (Object.keys(data.dependencies).length === 0) {
    delete data.dependencies;
  }
  if (Object.keys(data.devDependencies).length === 0) {
    delete data.devDependencies;
  }

  // Make sure there are no gitHead keys, which are only temporary keys used
  // when a package is actually being published.
  delete data.gitHead;

  // Ensure that there is a public access set, if the package is not private.
  if (data.private !== true) {
    data['publishConfig'] = { access: 'public' };
  }

  // Ensure there is a minimal prepublishOnly script
  if (!data.private && !data.scripts.prepublishOnly) {
    messages.push(`prepublishOnly script missing in ${pkgPath}`);
    data.scripts.prepublishOnly = 'npm run build';
  }

  if (utils.writePackageData(path.join(pkgPath, 'package.json'), data)) {
    messages.push('Updated package.json');
  }
  return messages;
}

/**
 * An extra ensure function just for the @jupyterlab/ui-components package.
 * Ensures that the icon svg import statements are synced with the contents
 * of ui-components/style/icons.
 *
 * @param pkgPath - The path to the @jupyterlab/ui-components package.
 * @param dorequire - If true, use `require` function in place of `import`
 *  statements when loading the icon svg files
 *
 * @returns A list of changes that were made to ensure the package.
 */
export async function ensureUiComponents(
  pkgPath: string,
  dorequire: boolean = false
): Promise<string[]> {
  const funcName = 'ensureUiComponents';
  let messages: string[] = [];

  const svgs = glob.sync(path.join(pkgPath, 'style/icons', '**/*.svg'));

  /* support for glob import of icon svgs */
  const iconSrcDir = path.join(pkgPath, 'src/icon');

  // build the per-icon import code
  let _iconImportStatements: string[] = [];
  let _iconModelDeclarations: string[] = [];
  let _wrappedIconDefs: string[] = [];
  svgs.forEach(svg => {
    const name = utils.stem(svg);
    const svgpath = path
      .relative(iconSrcDir, svg)
      .split(path.sep)
      .join('/');

    if (dorequire) {
      // load the icon svg using `require`
      _iconModelDeclarations.push(
        `{ name: '${name}', svg: require('${svgpath}').default }`
      );
    } else {
      // load the icon svg using `import`
      const svgname = utils.camelCase(name) + 'Svg';
      const iconname = utils.camelCase(name, true) + 'Icon';

      _iconImportStatements.push(`import ${svgname} from '${svgpath}';`);
      _iconModelDeclarations.push(`{ name: '${name}', svg: ${svgname} }`);
      _wrappedIconDefs.push(
        `export const ${iconname} = createIcon('${name}', ${svgname});`
      );
    }
  });
  const iconImportStatements = _iconImportStatements.join('\n');
  const iconModelDeclarations = _iconModelDeclarations.join(',\n');
  const wrappedIconDefs = _wrappedIconDefs.join('\n');

  // generate the actual contents of the iconImports file
  const iconImportsPath = path.join(iconSrcDir, 'iconimports.ts');
  const iconImportsContents = utils.fromTemplate(
    HEADER_TEMPLATE + ICON_IMPORTS_TEMPLATE,
    { funcName, iconImportStatements, iconModelDeclarations, wrappedIconDefs }
  );
  messages.push(...ensureFile(iconImportsPath, iconImportsContents));

  /* support for deprecated icon CSS classes */
  const iconCSSDir = path.join(pkgPath, 'style');

  // build the per-icon import code
  let _iconCSSUrls: string[] = [];
  let _iconCSSDeclarations: string[] = [];
  svgs.forEach(svg => {
    const name = utils.stem(svg);
    const urlName = 'jp-icon-' + name;
    const className = 'jp-' + utils.camelCase(name, true) + 'Icon';

    _iconCSSUrls.push(
      `--${urlName}: url('${path
        .relative(iconCSSDir, svg)
        .split(path.sep)
        .join('/')}');`
    );
    _iconCSSDeclarations.push(
      `.${className} {background-image: var(--${urlName})}`
    );
  });
  const iconCSSUrls = _iconCSSUrls.join('\n');
  const iconCSSDeclarations = _iconCSSDeclarations.join('\n');

  // generate the actual contents of the iconCSSClasses file
  const iconCSSClassesPath = path.join(iconCSSDir, 'deprecated.css');
  const iconCSSClassesContent = utils.fromTemplate(
    HEADER_TEMPLATE + ICON_CSS_CLASSES_TEMPLATE,
    { funcName, iconCSSUrls, iconCSSDeclarations }
  );
  messages.push(...ensureFile(iconCSSClassesPath, iconCSSClassesContent));

  return messages;
}

/**
 * The options used to ensure a package.
 */
export interface IEnsurePackageOptions {
  /**
   * The path to the package.
   */
  pkgPath: string;

  /**
   * The package data.
   */
  data: any;

  /**
   * The cache of dependency versions by package.
   */
  depCache?: { [key: string]: string };

  /**
   * A list of dependencies that can be unused.
   */
  unused?: string[];

  /**
   * A list of dependencies that can be missing.
   */
  missing?: string[];

  /**
   * A map of local package names and their relative path.
   */
  locals?: { [key: string]: string };

  /**
   * Whether to enforce that dependencies get used.  Default is true.
   */
  noUnused?: boolean;

  /**
   * The css import list for the package.
   */
  cssImports?: string[];

  /**
   * Packages which are allowed to have multiple versions pulled in
   */
  differentVersions?: string[];
}

/**
 * Ensure that contents of a file match a supplied string. If they do match,
 * do nothing and return an empty array. If they don't match, overwrite the
 * file and return an array with an update message.
 *
 * @param fpath: The path to the file being checked. The file must exist,
 * or else this function does nothing.
 *
 * @param contents: The desired file contents.
 *
 * @param prettify: default = true. If true, format the contents with
 * `prettier` before comparing/writing. Set to false only if you already
 * know your code won't be modified later by the `prettier` git commit hook.
 *
 * @returns a string array with 0 or 1 messages.
 */
function ensureFile(
  fpath: string,
  contents: string,
  prettify: boolean = true
): string[] {
  let messages: string[] = [];

  if (!fs.existsSync(fpath)) {
    // bail
    messages.push(
      `Tried to ensure the contents of ${fpath}, but the file does not exist`
    );
    return messages;
  }

  // (maybe) run the newly generated contents through prettier before comparing
  let formatted = prettify
    ? prettier.format(contents, { filepath: fpath, singleQuote: true })
    : contents;

  const prev = fs.readFileSync(fpath, { encoding: 'utf8' });
  if (prev.indexOf('\r') !== -1) {
    // Normalize line endings to match current content
    formatted = formatted.replace(/\n/g, '\r\n');
  }
  if (prev !== formatted) {
    // Write out changes and notify
    fs.writeFileSync(fpath, formatted);

    const msgpath = fpath.startsWith('/') ? fpath : `./${fpath}`;
    messages.push(`Updated ${msgpath}`);
  }

  return messages;
}

/**
 * Extract the module imports from a TypeScript source file.
 *
 * @param sourceFile - The path to the source file.
 *
 * @returns An array of package names.
 */
function getImports(sourceFile: ts.SourceFile): string[] {
  let imports: string[] = [];
  handleNode(sourceFile);

  function handleNode(node: any): void {
    switch (node.kind) {
      case ts.SyntaxKind.ImportDeclaration:
        imports.push(node.moduleSpecifier.text);
        break;
      case ts.SyntaxKind.ImportEqualsDeclaration:
        imports.push(node.moduleReference.expression.text);
        break;
      default:
      // no-op
    }
    ts.forEachChild(node, handleNode);
  }
  return imports;
}
