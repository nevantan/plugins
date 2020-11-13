/* eslint-disable no-param-reassign, no-shadow, no-underscore-dangle, no-continue */

import { dirname } from 'path';

import { attachScopes, extractAssignedNames, makeLegalIdentifier } from '@rollup/pluginutils';
import { walk } from 'estree-walker';
import MagicString from 'magic-string';

import {
  getDefinePropertyCallName,
  getKeypath,
  isDefineCompiledEsm,
  isFalsy,
  isReference,
  isTruthy,
  KEY_COMPILED_ESM
} from './ast-utils';
import {
  getRequireHandlers,
  getRequireStringArg,
  hasDynamicModuleForPath,
  isIgnoredRequireStatement,
  isModuleRequire,
  isNodeRequirePropertyAccess,
  isRequireStatement,
  isStaticRequireStatement
} from './handle-require-expressions';
import {
  DYNAMIC_JSON_PREFIX,
  DYNAMIC_REGISTER_PREFIX,
  getVirtualPathForDynamicRequirePath
} from './helpers';
import { tryParse } from './parse';
import { deconflict, getName, normalizePathSlashes } from './utils';

const exportsPattern = /^(?:module\.)?exports(?:\.([a-zA-Z_$][a-zA-Z_$0-9]*))?$/;

const functionType = /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/;

export default function transformCommonjs(
  parse,
  code,
  id,
  isEsModule,
  ignoreGlobal,
  ignoreRequire,
  sourceMap,
  isDynamicRequireModulesEnabled,
  dynamicRequireModuleSet,
  disableWrap,
  commonDir,
  astCache
) {
  const ast = astCache || tryParse(parse, code, id);
  const magicString = new MagicString(code);
  const uses = {
    module: false,
    exports: false,
    global: false,
    require: false
  };
  let scope = attachScopes(ast, 'scope');
  let lexicalDepth = 0;
  let programDepth = 0;
  let shouldWrap = false;
  let usesCommonjsHelpers = false;
  const defineCompiledEsmExpressions = [];

  const globals = new Set();

  // TODO technically wrong since globals isn't populated yet, but ¯\_(ツ)_/¯
  const HELPERS_NAME = deconflict(scope, globals, 'commonjsHelpers');
  const namedExports = {};
  const dynamicRegisterSources = new Set();

  const {
    addRequireStatement,
    requiredSources,
    rewriteRequireExpressionsAndGetImportBlock
  } = getRequireHandlers();

  // See which names are assigned to. This is necessary to prevent
  // illegally replacing `var foo = require('foo')` with `import foo from 'foo'`,
  // where `foo` is later reassigned. (This happens in the wild. CommonJS, sigh)
  const reassignedNames = new Set();
  const topLevelDeclarations = [];
  const topLevelRequireDeclarators = new Set();
  const skippedNodes = new Set();
  const topLevelModuleExportsAssignments = [];
  const topLevelExportsAssignmentsByName = new Map();

  walk(ast, {
    enter(node, parent) {
      if (skippedNodes.has(node)) {
        this.skip();
        return;
      }

      programDepth += 1;
      if (node.scope) ({ scope } = node);
      if (functionType.test(node.type)) lexicalDepth += 1;
      if (sourceMap) {
        magicString.addSourcemapLocation(node.start);
        magicString.addSourcemapLocation(node.end);
      }

      // eslint-disable-next-line default-case
      switch (node.type) {
        case 'AssignmentExpression':
          if (node.left.type === 'MemberExpression') {
            const flattened = getKeypath(node.left);
            if (!flattened || scope.contains(flattened.name)) return;

            const exportsPatternMatch = exportsPattern.exec(flattened.keypath);
            if (!exportsPatternMatch || flattened.keypath === 'exports') return;

            const [, exportName] = exportsPatternMatch;
            uses[flattened.name] = true;

            // we're dealing with `module.exports = ...` or `[module.]exports.foo = ...` –
            if (programDepth > 3) {
              shouldWrap = true;
            } else if (exportName === KEY_COMPILED_ESM) {
              defineCompiledEsmExpressions.push(parent);
            } else if (flattened.keypath === 'module.exports') {
              topLevelModuleExportsAssignments.push(node);
            } else if (!topLevelExportsAssignmentsByName.has(exportName)) {
              topLevelExportsAssignmentsByName.set(exportName, node);
            } else {
              shouldWrap = true;
            }

            skippedNodes.add(node.left);

            if (flattened.keypath === 'module.exports' && node.right.type === 'ObjectExpression') {
              node.right.properties.forEach((prop) => {
                if (prop.computed || !('key' in prop) || prop.key.type !== 'Identifier') return;
                const { name } = prop.key;
                if (name === makeLegalIdentifier(name)) namedExports[name] = true;
              });
              return;
            }

            if (exportsPatternMatch[1]) namedExports[exportsPatternMatch[1]] = true;
          } else {
            for (const name of extractAssignedNames(node.left)) {
              reassignedNames.add(name);
            }
          }
          return;
        case 'CallExpression': {
          if (isDefineCompiledEsm(node)) {
            if (programDepth === 3 && parent.type === 'ExpressionStatement') {
              // skip special handling for [module.]exports until we know we render this
              skippedNodes.add(node.arguments[0]);
              defineCompiledEsmExpressions.push(parent);
            } else {
              shouldWrap = true;
            }
            return;
          }
          const name = getDefinePropertyCallName(node, 'exports');
          if (name) {
            if (name === makeLegalIdentifier(name)) {
              namedExports[name] = true;
            }
            return;
          }
          if (!isStaticRequireStatement(node, scope)) return;
          if (!isDynamicRequireModulesEnabled) {
            skippedNodes.add(node.callee);
          }
          if (!isIgnoredRequireStatement(node, ignoreRequire)) {
            skippedNodes.add(node.callee);
            const usesReturnValue = parent.type !== 'ExpressionStatement';

            let sourceId = getRequireStringArg(node);
            const isDynamicRegister = sourceId.startsWith(DYNAMIC_REGISTER_PREFIX);
            if (isDynamicRegister) {
              sourceId = sourceId.substr(DYNAMIC_REGISTER_PREFIX.length);
              if (sourceId.endsWith('.json')) {
                sourceId = DYNAMIC_JSON_PREFIX + sourceId;
              }
              dynamicRegisterSources.add(sourceId);
            } else {
              if (
                !sourceId.endsWith('.json') &&
                hasDynamicModuleForPath(sourceId, id, dynamicRequireModuleSet)
              ) {
                magicString.overwrite(
                  node.start,
                  node.end,
                  `${HELPERS_NAME}.commonjsRequire(${JSON.stringify(
                    getVirtualPathForDynamicRequirePath(normalizePathSlashes(sourceId), commonDir)
                  )}, ${JSON.stringify(
                    dirname(id) === '.'
                      ? null /* default behavior */
                      : getVirtualPathForDynamicRequirePath(
                          normalizePathSlashes(dirname(id)),
                          commonDir
                        )
                  )})`
                );
                usesCommonjsHelpers = true;
                return;
              }
              addRequireStatement(sourceId, node, scope, usesReturnValue);
            }

            if (usesReturnValue) {
              if (
                parent.type === 'VariableDeclarator' &&
                !scope.parent &&
                parent.id.type === 'Identifier'
              ) {
                // This will allow us to reuse this variable name as the imported variable if it is not reassigned
                // and does not conflict with variables in other places where this is imported
                topLevelRequireDeclarators.add(parent);
              }
            } else {
              // This is a bare import, e.g. `require('foo');`
              magicString.remove(parent.start, parent.end);
            }
          }
          return;
        }
        case 'ConditionalExpression':
        case 'IfStatement':
          // skip dead branches
          if (isFalsy(node.test)) {
            skippedNodes.add(node.consequent);
          } else if (node.alternate && isTruthy(node.test)) {
            skippedNodes.add(node.alternate);
          }
          return;
        case 'Identifier': {
          const { name } = node;
          if (!(isReference(node, parent) && !scope.contains(name))) return;
          switch (name) {
            case 'require':
              if (isNodeRequirePropertyAccess(parent)) return;

              if (isDynamicRequireModulesEnabled && isRequireStatement(parent, scope)) {
                magicString.appendLeft(
                  parent.end - 1,
                  `,${JSON.stringify(
                    dirname(id) === '.'
                      ? null /* default behavior */
                      : getVirtualPathForDynamicRequirePath(
                          normalizePathSlashes(dirname(id)),
                          commonDir
                        )
                  )}`
                );
              }

              magicString.overwrite(node.start, node.end, `${HELPERS_NAME}.commonjsRequire`, {
                storeName: true
              });
              usesCommonjsHelpers = true;
              return;
            case 'module':
            case 'exports':
              shouldWrap = true;
              uses[name] = true;
              return;
            case 'global':
              uses.global = true;
              if (!ignoreGlobal) {
                magicString.overwrite(node.start, node.end, `${HELPERS_NAME}.commonjsGlobal`, {
                  storeName: true
                });
                usesCommonjsHelpers = true;
              }
              return;
            case 'define':
              magicString.overwrite(node.start, node.end, 'undefined', { storeName: true });
              return;
            default:
              globals.add(name);
              return;
          }
        }
        case 'MemberExpression':
          if (!isDynamicRequireModulesEnabled && isModuleRequire(node, scope)) {
            magicString.overwrite(node.start, node.end, `${HELPERS_NAME}.commonjsRequire`, {
              storeName: true
            });
            usesCommonjsHelpers = true;
            skippedNodes.add(node.object);
            skippedNodes.add(node.property);
          }
          return;
        case 'ReturnStatement':
          // if top-level return, we need to wrap it
          if (lexicalDepth === 0) {
            shouldWrap = true;
          }
          return;
        case 'ThisExpression':
          // rewrite top-level `this` as `commonjsHelpers.commonjsGlobal`
          if (lexicalDepth === 0) {
            uses.global = true;
            if (!ignoreGlobal) {
              magicString.overwrite(node.start, node.end, `${HELPERS_NAME}.commonjsGlobal`, {
                storeName: true
              });
              usesCommonjsHelpers = true;
            }
          }
          return;
        case 'UnaryExpression':
          // rewrite `typeof module`, `typeof module.exports` and `typeof exports` (https://github.com/rollup/rollup-plugin-commonjs/issues/151)
          if (node.operator === 'typeof') {
            const flattened = getKeypath(node.argument);
            if (!flattened) return;

            if (scope.contains(flattened.name)) return;

            if (
              flattened.keypath === 'module.exports' ||
              flattened.keypath === 'module' ||
              flattened.keypath === 'exports'
            ) {
              magicString.overwrite(node.start, node.end, `'object'`, { storeName: false });
            }
          }
          return;
        case 'VariableDeclaration':
          if (!scope.parent) {
            topLevelDeclarations.push(node);
          }
      }
    },

    leave(node) {
      programDepth -= 1;
      if (node.scope) scope = scope.parent;
      if (functionType.test(node.type)) lexicalDepth -= 1;
    }
  });

  let isCompiledEsm = false;
  if (defineCompiledEsmExpressions.length > 0) {
    if (!shouldWrap && defineCompiledEsmExpressions.length === 1) {
      isCompiledEsm = true;
      magicString.remove(
        defineCompiledEsmExpressions[0].start,
        defineCompiledEsmExpressions[0].end
      );
    } else {
      shouldWrap = true;
      uses.exports = true;
    }
  }

  // We cannot wrap ES/mixed modules
  shouldWrap = shouldWrap && !disableWrap && !isEsModule;
  usesCommonjsHelpers = usesCommonjsHelpers || shouldWrap;

  if (
    !(
      requiredSources.length ||
      dynamicRegisterSources.size ||
      uses.module ||
      uses.exports ||
      uses.require ||
      usesCommonjsHelpers
    ) &&
    (ignoreGlobal || !uses.global)
  ) {
    return { meta: { commonjs: { isCommonJS: false } } };
  }

  const namedExportDeclarations = [];
  let wrapperStart = '';
  let wrapperEnd = '';

  const moduleName = deconflict(scope, globals, getName(id));
  const defaultExportPropertyAssignments = [];
  let hasDefaultExport = false;
  let deconflictedDefaultExportName;

  if (shouldWrap) {
    const args = `module${uses.exports ? ', exports' : ''}`;

    wrapperStart = `var ${moduleName} = ${HELPERS_NAME}.createCommonjsModule(function (${args}) {\n`;

    wrapperEnd = `\n}`;
    if (isDynamicRequireModulesEnabled) {
      wrapperEnd += `, ${JSON.stringify(
        getVirtualPathForDynamicRequirePath(normalizePathSlashes(dirname(id)), commonDir)
      )}`;
    }

    wrapperEnd += `);`;
  } else {
    // TODO Lukas extract logic to generate exports
    const names = [];

    for (const { left } of topLevelModuleExportsAssignments) {
      hasDefaultExport = true;
      magicString.overwrite(left.start, left.end, `var ${moduleName}`);
    }
    for (const [exportName, node] of topLevelExportsAssignmentsByName) {
      const deconflicted = deconflict(scope, globals, exportName);
      names.push({ exportName, deconflicted });
      magicString.overwrite(node.start, node.left.end, `var ${deconflicted}`);

      if (exportName === 'default') {
        deconflictedDefaultExportName = deconflicted;
      } else {
        namedExportDeclarations.push({
          str:
            exportName === deconflicted
              ? `export { ${exportName} };`
              : `export { ${deconflicted} as ${exportName} };`,
          exportName
        });
      }

      defaultExportPropertyAssignments.push(`${moduleName}.${exportName} = ${deconflicted};`);
    }

    if (!isEsModule && !hasDefaultExport) {
      const moduleExports = `{\n${names
        .map(({ exportName, deconflicted }) => `\t${exportName}: ${deconflicted}`)
        .join(',\n')}\n}`;
      wrapperEnd = `\n\nvar ${moduleName} = ${
        isCompiledEsm
          ? `/*#__PURE__*/Object.defineProperty(${moduleExports}, '__esModule', {value: true})`
          : moduleExports
      };`;
    }
  }

  if (!isEsModule) {
    const exportModuleExports = {
      str: `export { ${moduleName} as __moduleExports };`,
      name: '__moduleExports'
    };

    namedExportDeclarations.unshift(exportModuleExports);
  }

  const defaultExport = [];
  if (!isEsModule) {
    if (isCompiledEsm) {
      defaultExport.push(`export default ${deconflictedDefaultExportName || moduleName};`);
    } else if (
      (shouldWrap || deconflictedDefaultExportName) &&
      (defineCompiledEsmExpressions.length > 0 || code.indexOf('__esModule') >= 0)
    ) {
      usesCommonjsHelpers = true;
      defaultExport.push(
        `export default /*@__PURE__*/${HELPERS_NAME}.getDefaultExportFromCjs(${moduleName});`
      );
    } else {
      defaultExport.push(`export default ${moduleName};`);
    }
  }

  const named = namedExportDeclarations
    .filter((x) => x.name !== 'default' || !hasDefaultExport)
    .map((x) => x.str);

  const importBlock = rewriteRequireExpressionsAndGetImportBlock(
    magicString,
    topLevelDeclarations,
    topLevelRequireDeclarators,
    reassignedNames,
    usesCommonjsHelpers && HELPERS_NAME,
    dynamicRegisterSources
  );

  magicString
    .trim()
    .prepend(importBlock + wrapperStart)
    .trim()
    .append(
      `${wrapperEnd}\n\n${defaultExport
        .concat(named)
        .concat(hasDefaultExport ? defaultExportPropertyAssignments : [])
        .join('\n')}`
    );

  return {
    code: magicString.toString(),
    map: sourceMap ? magicString.generateMap() : null,
    syntheticNamedExports: isEsModule ? false : '__moduleExports',
    meta: { commonjs: { isCommonJS: !isEsModule } }
  };
}
