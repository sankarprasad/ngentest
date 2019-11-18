const path = require('path');
const ejs = require('ejs');
const fs = require('fs');
const { TypescriptParser } = require('typescript-parser');

const Util = require('./util.js');

async function getKlass () {
  const parser = new TypescriptParser();
  const klassName = Util.getClassName(this.tsPath);
  // const srcFile = createSourceFile('inline.tsx', this.typescript, ScriptTarget.ES2015, true, ScriptKind.TS);
  // const parsed = parser['parseTypescript'](srcFile, '/');
  const parsed = await parser.parseSource(this.typescript);

  const klass =
    parsed.declarations.find(decl => decl.name === klassName) ||
    parsed.declarations.find(decl => decl.constructor.name === 'ClassDeclaration');

  if (!klass) {
    throw new Error(`Error:NgTypeScriptParser Could not find ` +
      `${this.klassName || 'a class'} from ${this.tsPath}`);
  }

  return klass;
}

async function getKlassImports () {
  const imports = {};

  const parser = new TypescriptParser();
  const parsed = await parser.parseSource(this.typescript);
  // const srcFile = createSourceFile('inline.tsx', this.typescript, ScriptTarget.ES2015, true, ScriptKind.TS);
  // const parsed = parser['parseTypescript'](srcFile, '/');
  parsed.imports.forEach(mport => {
    if (mport.constructor.name === 'NamedImport') {
      mport.specifiers.forEach(specifier => {
        imports[specifier.alias || specifier.specifier] = { mport, specifier };
      });
    } else if (mport.constructor.name === 'NamespaceImport') {
      imports[mport.alias || mport.libraryName] = { mport };
    }
  });

  return imports;
}

function getInputs (klass) {
  const inputs = { attributes: [], properties: [] };
  (klass.properties || []).forEach(prop => {
    const key = prop.name;
    const body = this.typescript.substring(prop.start, prop.end);
    if (body.match(/@Input\(/)) {
      const attrName =
        prop.body ? (prop.body.match(/@Input\(['"](.*?)['"]\)/) || [])[1] : prop.name;
      inputs.attributes.push(`[${attrName || key}]="${key}"`);
      inputs.properties.push(`${key}: ${prop.type};`);
    }
  });

  return inputs;
}

function getOutputs (klass) {
  const outputs = { attributes: [], properties: [] };
  (klass.properties || []).forEach(prop => {
    const key = prop.name;
    const body = this.typescript.substring(prop.start, prop.end);
    if (body.match(/@Output\(/)) {
      const attrName =
        prop.body ? (prop.body.match(/@Input\(['"](.*?)['"]\)/) || [])[1] : prop.name;
      const funcName = `on${key.replace(/^[a-z]/, x => x.toUpperCase())}`;
      outputs.attributes.push(`(${attrName || key})="${funcName}($event)"`);
      outputs.properties.push(`${funcName}(event): void { /* */ }`);
    }
  });

  return outputs;
}

function getImports (klass) {
  const imports = {};
  const constructorParams = (klass.ctor && klass.ctor.parameters) || [];

  imports['@angular/core'] = ['Component'];
  imports[`./${path.basename(this.tsPath)}`.replace(/.ts$/, '')] = [klass.name];

  constructorParams.forEach((param, index) => {
    const paramBody = this.typescript.substring(param.start, param.end);

    const injectMatches = paramBody.match(/@Inject\(([A-Z0-9_]+)\)/) || [];
    const injectClassName = injectMatches[1];
    if (injectClassName) { // e.g. @Inject(LOCALE_ID) language
      const iimport = this.imports[injectClassName];
      imports[iimport.mport.libraryName] = imports[iimport.mport.libraryName] || [];
      imports[iimport.mport.libraryName].push(injectClassName);
      // imports[iimport.mport.libraryName].push(param.type);
    } else {
      const className = (param.type || '').replace(/<[^>]+>/, '');
      const iimport = this.imports[className];

      if (iimport) {
        const importStr = iimport.mport.alias ?
          `${iimport.specifier.specifier} as ${iimport.mport.alias}` : iimport.specifier.specifier;
        imports[iimport.mport.libraryName] = imports[iimport.mport.libraryName] || [];
        imports[iimport.mport.libraryName].push(importStr);
      }
    }
  });

  return imports;
}

/* @returns @Component providers: code */
function getProviders (klass) {
  const constructorParams = (klass.ctor && klass.ctor.parameters) || [];
  const providers = {};

  constructorParams.forEach((param, index) => { // name, type, start, end
    const paramBody = this.typescript.substring(param.start, param.end);
    const injectMatches = paramBody.match(/@Inject\(([A-Z0-9_]+)\)/i) || [];
    const injectClassName = injectMatches[1];
    const className = (param.type || '').replace(/<[^>]+>/, '');
    const iimport = this.imports[className];

    if (injectClassName === 'DOCUMENT') {
      providers[param.name] = `{ provide: DOCUMENT, useClass: MockDocument }`;
    } else if (injectClassName === 'PLATFORM_ID') {
      providers[param.name] = `{ provide: 'PLATFORM_ID', useValue: 'browser' }`;
    } else if (injectClassName === 'LOCALE_ID') {
      providers[param.name] = `{ provide: 'LOCALE_ID', useValue: 'en' }`;
    } else if (injectClassName) {
      providers[param.name] = `{ provide: ${injectClassName}, useValue: ${injectClassName} }`;
    } else if (param.type.match(/^(ElementRef|Router|HttpClient|TranslateService)$/)) {
      providers[param.name] = `{ provide: ${param.type}, useClass: Mock${param.type} }`;
    } else if (iimport && iimport.mport.libraryName.match(/^\./)) { // user-defined classes
      providers[param.name] = `{ provide: ${param.type}, useClass: Mock${param.type} }`;
    } else {
      providers[param.name] = param.type;
    }
  });

  return providers;
}

/* @returns mock data for this test */
/* ctorParams : { key: <value in JS object> */
function getProviderMocks (klass, ctorParams) {
  const mocks = {};
  // const providers = this._getProviders(klass);
  /* { var: { provide: 'Class', useClass: 'MockClass'}, ...} */

  function getCtorVarsJS (varName) {
    const vars = ctorParams[varName];
    return Object.entries(vars).map(([key, value]) => {
      // console.log(`>>>>>>>>>>>>>>>> value`, value);
      return `${key} = ${Util.objToJS(value)};`;
    });
  }

  const constructorParams = (klass.ctor && klass.ctor.parameters) || [];
  constructorParams.forEach(param => {
    const iimport = this.imports[param.type];
    const ctorVars = getCtorVarsJS(param.name);
    const typeVars = /* eslint-disable */
      param.type === 'ElementRef' ? ['nativeElement = {};'] :
      param.type === 'Router' ? ['navigate = jest.fn();'] :
      param.type === 'Document' ? ['querySelector = jest.fn();'] :
      param.type === 'HttpClient' ? ['post = jest.fn();'] :
      param.type === 'TranslateService' ? ['translate = jest.fn();'] :
      iimport && iimport.mport.libraryName.match(/^[\.]+/) ? []  : undefined;
      /* eslint-enable */

    if (typeVars) {
      const mockVars = ctorVars.concat(typeVars).join('\n');
      mocks[param.type] = `
        @Injectable()
        class Mock${param.type} {
          ${mockVars}
        }`;
    }
  });

  return mocks;
}

function getGenerated (ejsData) {
  const generated = ejs.render(this.template, ejsData).replace(/\n\s+$/gm, '\n');
  return generated;
}

function writeGenerated (generated, toFile, force) {
  const specPath = path.resolve(this.tsPath.replace(/\.ts$/, '.spec.ts'));
  generated = generated.replace(/\r\n/g, '\n');

  const writeToFile = function () {
    fs.writeFileSync(specPath, generated);
    console.log('Generated unit test to', specPath);
  };

  const backupExistingFile = function () {
    if (fs.existsSync(specPath)) {
      const backupTime = (new Date()).toISOString().replace(/[^\d]/g, '').slice(0, -5);
      const backupContents = fs.readFileSync(specPath, 'utf8');
      if (backupContents !== generated) {
        fs.writeFileSync(`${specPath}.${backupTime}`, backupContents, 'utf8'); // write backup
        console.log('Backup the exisiting file to', `${specPath}.${backupTime}`);
      }
    }
  };

  const specFileExists = fs.existsSync(specPath);

  if (toFile && specFileExists && force) {
    backupExistingFile();
    writeToFile();
  } else if (toFile && specFileExists && !force) {
    const readline = require('readline');
    const rl = readline.createInterface(process.stdin, process.stdout);
    console.warn('\x1b[33m%s\x1b[0m',
      `WARNING!!, Spec file, ${specPath} already exists. Overwrite it?`);
    rl.question('Continue? ', answer => {
      if (answer.match(/y/i)) {
        backupExistingFile();
        writeToFile();
      } else {
        process.stdout.write(generated);
      }
      rl.close();
    });
  } else if (toFile && !specFileExists) {
    backupExistingFile();
    writeToFile();
  } else if (!toFile) {
    process.stdout.write(generated);
  }
}

const CommonTestFunctions = {
  getKlass, // class info.
  getKlassImports, // imports info.

  getInputs, // input coddes
  getOutputs, // output codes
  getImports, // import statements code
  getProviders, // module provider code
  getProviderMocks, // module provider mock code

  getGenerated,
  writeGenerated
};

module.exports = CommonTestFunctions;