import { Resolver, warn, TemplateCompiler } from '@embroider/core';
import {
  ComponentRules,
  PackageRules,
  PreprocessedComponentRule,
  preprocessComponentRule,
  ActivePackageRules,
  ModuleRules,
} from './dependency-rules';
import Options from './options';
import { join, relative, dirname } from 'path';
import { pathExistsSync } from 'fs-extra';
import { dasherize } from './string';
import { makeResolverTransform } from './resolver-transform';
import { Memoize } from 'typescript-memoize';
import { ResolvedDep } from '@embroider/core/src/resolver';

type ResolutionResult =
  | {
      type: 'component';
      modules: ResolvedDep[];
      yieldsComponents: Required<ComponentRules>['yieldsSafeComponents'];
      argumentsAreComponents: string[];
    }
  | {
      type: 'helper';
      modules: ResolvedDep[];
    };

interface ResolutionFail {
  type: 'error';
  hardFail: boolean;
  message: string;
}

export type Resolution = ResolutionResult | ResolutionFail;

// TODO: this depends on the ember version. And it's probably missing some
// private-but-used values.
const builtInHelpers = [
  '-get-dynamic-var',
  '-in-element',
  '-with-dynamic-vars',
  'action',
  'array',
  'component',
  'concat',
  'debugger',
  'each-in',
  'each',
  'get',
  'hasBlock',
  'hasBlockParams',
  'hash',
  'if',
  'input',
  'let',
  'link-to',
  'loc',
  'log',
  'mount',
  'mut',
  'outlet',
  'partial',
  'query-params',
  'readonly',
  'textarea',
  'unbound',
  'unless',
  'with',
  'yield',
];

// this is a subset of the full Options. We care about serializability, and we
// only needs parts that are easily serializable, which is why we don't keep the
// whole thing.
type ResolverOptions = Pick<Required<Options>, 'staticHelpers' | 'staticComponents'>;

function extractOptions(options: Required<Options> | ResolverOptions): ResolverOptions {
  return {
    staticHelpers: options.staticHelpers,
    staticComponents: options.staticComponents,
  };
}

export function rehydrate(params: {
  root: string;
  modulePrefix: string;
  options: ResolverOptions;
  activePackageRules: ActivePackageRules[];
}) {
  return new CompatResolver(params.root, params.modulePrefix, params.options, params.activePackageRules);
}

export default class CompatResolver implements Resolver {
  private options: ResolverOptions;
  private dependencies: Map<string, Resolution[]> = new Map();
  private templateCompiler: TemplateCompiler | undefined;

  _parallelBabel: any;

  constructor(
    private root: string,
    private modulePrefix: string,
    options: ResolverOptions,
    private activePackageRules: ActivePackageRules[]
  ) {
    this.options = extractOptions(options);
    this._parallelBabel = {
      requireFile: __filename,
      buildUsing: 'rehydrate',
      params: {
        root: root,
        modulePrefix: modulePrefix,
        options: this.options,
        activePackageRules: activePackageRules,
      },
    };
  }

  enter(moduleName: string) {
    this.dependencies.set(moduleName, []);
  }

  private add(resolution: Resolution, from: string) {
    // this "!" is safe because we always `enter()` a module before hitting this
    this.dependencies.get(from)!.push(resolution);
    return resolution;
  }

  private findComponentRules(absPath: string) {
    return this.rules.components.get(absPath);
  }

  private isIgnoredComponent(dasherizedName: string) {
    return this.rules.ignoredComponents.includes(dasherizedName);
  }

  @Memoize()
  private get rules() {
    if (!this.templateCompiler) {
      throw new Error(
        `Bug: Resolver needs to get linked into a TemplateCompiler before it can understand packageRules`
      );
    }

    // keyed by their first resolved dependency's runtimeName.
    let components: Map<string, PreprocessedComponentRule> = new Map();

    // keyed by our own dasherized interpretatino of the component's name.
    let ignoredComponents: string[] = [];

    // we're not responsible for filtering out rules for inactive packages here,
    // that is done before getting to us. So we should assume these are all in
    // force.
    for (let rule of this.activePackageRules) {
      if (rule.components) {
        for (let [snippet, componentRules] of Object.entries(rule.components)) {
          if (componentRules.safeToIgnore) {
            ignoredComponents.push(this.standardDasherize(snippet, rule));
            continue;
          }
          let resolvedDep = this.resolveComponentSnippet(snippet, rule).modules[0];
          let processedRules = preprocessComponentRule(componentRules);

          // we always register our rules on the component's own first resolved
          // module, which must be a module in the app's module namespace.
          components.set(resolvedDep.absPath, processedRules);

          // if there's a custom layout, we also need to register our rules on
          // those templates.
          if (componentRules.layout) {
            if (componentRules.layout.appPath) {
              components.set(join(this.root, componentRules.layout.appPath), processedRules);
            } else if (componentRules.layout.addonPath) {
              for (let root of rule.roots) {
                components.set(join(root, componentRules.layout.addonPath), processedRules);
              }
            } else {
              throw new Error(
                `layout property in component rule must contain either appPath or addonPath: ${JSON.stringify(
                  rule,
                  null,
                  2
                )}`
              );
            }
          }
        }
      }
    }
    return { components, ignoredComponents };
  }

  resolveComponentSnippet(snippet: string, rule: PackageRules | ModuleRules): ResolutionResult & { type: 'component' } {
    if (!this.templateCompiler) {
      throw new Error(`bug: tried to use resolveComponentSnippet without a templateCompiler`);
    }
    let name = this.standardDasherize(snippet, rule);
    let found = this.tryComponent(name, 'rule-snippet.hbs', false);
    if (found && found.type === 'component') {
      return found;
    }
    throw new Error(`unable to locate component ${snippet} referred to in rule ${JSON.stringify(rule, null, 2)}`);
  }

  private standardDasherize(snippet: string, rule: PackageRules | ModuleRules): string {
    if (!this.templateCompiler) {
      throw new Error(`bug: tried to use resolveComponentSnippet without a templateCompiler`);
    }
    let ast: any;
    try {
      ast = this.templateCompiler.parse('snippet.hbs', snippet);
    } catch (err) {
      throw new Error(`unable to parse component snippet "${snippet}" from rule ${JSON.stringify(rule, null, 2)}`);
    }
    if (ast.type === 'Program' && ast.body.length > 0) {
      let first = ast.body[0];
      if (first.type === 'MustacheStatement' && first.path.type === 'PathExpression') {
        return first.path.original;
      }
      if (first.type === 'ElementNode') {
        return dasherize(first.tag);
      }
    }
    throw new Error(`cannot identify a component in rule snippet: "${snippet}"`);
  }

  astTransformer(templateCompiler: TemplateCompiler): unknown {
    this.templateCompiler = templateCompiler;
    return makeResolverTransform(this);
  }

  dependenciesOf(moduleName: string): ResolvedDep[] {
    let flatDeps: Map<string, ResolvedDep> = new Map();
    let deps = this.dependencies.get(moduleName);
    if (deps) {
      for (let dep of deps) {
        if (dep.type === 'error') {
          if (dep.hardFail) {
            throw new Error(dep.message);
          } else {
            warn(dep.message);
          }
        } else {
          for (let entry of dep.modules) {
            let { runtimeName } = entry;
            flatDeps.set(runtimeName, entry);
          }
        }
      }
    }
    return [...flatDeps.values()];
  }

  private tryHelper(path: string, from: string): Resolution | null {
    let absPath = join(this.root, 'helpers', path) + '.js';
    if (pathExistsSync(absPath)) {
      return {
        type: 'helper',
        modules: [
          {
            runtimeName: `${this.modulePrefix}/helpers/${path}`,
            path: explicitRelative(from, absPath),
            absPath,
          },
        ],
      };
    }
    return null;
  }

  private tryComponent(path: string, from: string, withRuleLookup = true): Resolution | null {
    let componentModules = [
      // The order here is important! We always put our .hbs paths first here,
      // so that if we have an hbs file of our own, that will be the first
      // resolved dependency. The first resolved dependency is special because
      // we use that as a key into the rules, and we want to be able to find our
      // rules when checking from our own template (among other times).
      {
        runtimeName: `${this.modulePrefix}/templates/components/${path}`,
        absPath: join(this.root, 'templates', 'components', path) + '.hbs',
      },
      {
        runtimeName: `${this.modulePrefix}/components/${path}`,
        absPath: join(this.root, 'components', path) + '.js',
      },
      {
        runtimeName: `${this.modulePrefix}/templates/components/${path}`,
        absPath: join(this.root, 'templates', 'components', path) + '.js',
      },
    ].filter(candidate => pathExistsSync(candidate.absPath));

    if (componentModules.length > 0) {
      let componentRules;
      if (withRuleLookup) {
        componentRules = this.findComponentRules(componentModules[0].absPath);
      }
      return {
        type: 'component',
        modules: componentModules.map(p => ({
          path: explicitRelative(from, p.absPath),
          absPath: p.absPath,
          runtimeName: p.runtimeName,
        })),
        yieldsComponents: componentRules ? componentRules.yieldsSafeComponents : [],
        argumentsAreComponents: componentRules ? componentRules.argumentsAreComponents : [],
      };
    }

    return null;
  }

  resolveSubExpression(path: string, from: string): Resolution | null {
    if (!this.options.staticHelpers) {
      return null;
    }
    let found = this.tryHelper(path, from);
    if (found) {
      return this.add(found, from);
    }
    if (builtInHelpers.includes(path)) {
      return null;
    }
    return this.add(
      {
        type: 'error',
        hardFail: true,
        message: `Missing helper ${path} in ${from}`,
      },
      from
    );
  }

  resolveMustache(path: string, hasArgs: boolean, from: string): Resolution | null {
    if (this.options.staticHelpers) {
      let found = this.tryHelper(path, from);
      if (found) {
        return this.add(found, from);
      }
    }
    if (this.options.staticComponents) {
      let found = this.tryComponent(path, from);
      if (found) {
        return this.add(found, from);
      }
    }
    if (
      hasArgs &&
      this.options.staticComponents &&
      this.options.staticHelpers &&
      !builtInHelpers.includes(path) &&
      !this.isIgnoredComponent(path)
    ) {
      return this.add(
        {
          type: 'error',
          hardFail: true,
          message: `Missing component or helper ${path} in ${from}`,
        },
        from
      );
    } else {
      return null;
    }
  }

  resolveElement(tagName: string, from: string): Resolution | null {
    if (!this.options.staticComponents) {
      return null;
    }

    if (tagName[0] === tagName[0].toLowerCase()) {
      // starts with lower case, so this can't be a component we need to
      // globally resolve
      return null;
    }

    let dName = dasherize(tagName);

    let found = this.tryComponent(dName, from);
    if (found) {
      return this.add(found, from);
    }

    if (this.isIgnoredComponent(dName)) {
      return null;
    }

    return this.add(
      {
        type: 'error',
        hardFail: true,
        message: `Missing component ${tagName} in ${from}`,
      },
      from
    );
  }

  resolveComponentHelper(path: string, isLiteral: boolean, from: string): Resolution | null {
    if (!this.options.staticComponents) {
      return null;
    }
    if (!isLiteral) {
      let ownComponentRules = this.findComponentRules(from);
      if (ownComponentRules && ownComponentRules.safeInteriorPaths.includes(path)) {
        return null;
      }
      return this.add(
        {
          type: 'error',
          hardFail: false,
          message: `ignoring dynamic component ${path} in ${humanReadableFile(this.root, from)}`,
        },
        from
      );
    }
    let found = this.tryComponent(path, from);
    if (found) {
      return this.add(found, from);
    }
    return this.add(
      {
        type: 'error',
        hardFail: true,
        message: `Missing component ${path} in ${humanReadableFile(this.root, from)}`,
      },
      from
    );
  }

  unresolvableComponentArgument(componentName: string, argumentName: string, from: string) {
    this.add(
      {
        type: 'error',
        hardFail: false,
        message: `argument "${argumentName}" to component "${componentName}" in ${humanReadableFile(
          this.root,
          from
        )} is treated as a component, but the value you're passing is dynamic`,
      },
      from
    );
  }
}

// by "explicit", I mean that we want "./local/thing" instead of "local/thing"
// because
//     import "./local/thing"
// has a different meaning than
//     import "local/thing"
//
function explicitRelative(fromFile: string, toFile: string) {
  let result = relative(dirname(fromFile), toFile);
  if (!result.startsWith('/') && !result.startsWith('.')) {
    result = './' + result;
  }
  return result;
}

function humanReadableFile(root: string, file: string) {
  if (!root.endsWith('/')) {
    root += '/';
  }
  if (file.startsWith(root)) {
    return file.slice(root.length);
  }
  return file;
}
