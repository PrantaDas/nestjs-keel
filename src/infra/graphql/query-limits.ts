import type { ApolloDriverConfig } from '@nestjs/apollo';
import {
  GraphQLError,
  type ASTVisitor,
  type FragmentDefinitionNode,
  type SelectionSetNode,
  type ValidationContext,
  Kind,
} from 'graphql';
import { fieldExtensionsEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity';

/**
 * Rejects operations nested deeper than `maxDepth` (`a { b { c { … } } }`), before any resolver
 * runs. Fragments are followed; introspection fields (`__schema`) do not count.
 */
export function depthLimit(maxDepth: number) {
  return (context: ValidationContext): ASTVisitor => {
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const definition of context.getDocument().definitions) {
      if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition);
    }
    const depthOf = (selectionSet: SelectionSetNode | undefined, depth: number, seen: Set<string>): number => {
      if (!selectionSet) return depth;
      let max = depth;
      for (const selection of selectionSet.selections) {
        if (selection.kind === Kind.FIELD) {
          if (selection.name.value.startsWith('__')) continue;
          max = Math.max(max, depthOf(selection.selectionSet, depth + 1, seen));
        } else if (selection.kind === Kind.INLINE_FRAGMENT) {
          max = Math.max(max, depthOf(selection.selectionSet, depth, seen));
        } else {
          const name = selection.name.value;
          const fragment = fragments.get(name);
          if (fragment && !seen.has(name)) {
            max = Math.max(max, depthOf(fragment.selectionSet, depth, new Set([...seen, name])));
          }
        }
      }
      return max;
    };
    return {
      OperationDefinition(node) {
        const depth = depthOf(node.selectionSet, 0, new Set());
        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(`The query is nested too deeply (${depth} levels, at most ${maxDepth}).`, {
              nodes: [node],
              extensions: { code: 'QUERY_TOO_DEEP' },
            }),
          );
        }
      },
    };
  };
}

/**
 * Rejects operations whose estimated cost exceeds `maxComplexity` (each field costs 1, lists can
 * declare more with `@Field({ complexity })`), before execution: a single request cannot ask for
 * millions of nodes.
 */
type Listener = Awaited<ReturnType<NonNullable<Exclude<ApolloPlugin, undefined>['requestDidStart']>>>;
type DidResolve = Exclude<Listener, void>['didResolveOperation'];

/** Typed through the Nest driver config: @apollo/server ships ESM and CJS typings that do not unify. */
type ApolloPlugin = NonNullable<ApolloDriverConfig['plugins']>[number];

export function complexityLimit(maxComplexity: number): ApolloPlugin {
  return {
    requestDidStart: async () => ({
      didResolveOperation: async ({ request, document, schema }: Parameters<NonNullable<DidResolve>>[0]) => {
        const complexity = getComplexity({
          schema,
          query: document,
          operationName: request.operationName,
          variables: request.variables,
          estimators: [fieldExtensionsEstimator(), simpleEstimator({ defaultComplexity: 1 })],
        });
        if (complexity > maxComplexity) {
          throw new GraphQLError(`The query is too large (cost ${complexity}, at most ${maxComplexity}).`, {
            extensions: { code: 'QUERY_TOO_COMPLEX' },
          });
        }
      },
    }),
  };
}
