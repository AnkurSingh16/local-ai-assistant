// @ts-check
/**
 * Type-aware guard for the ModeratedText and UntrustedWebText brands (ADR-0002).
 *
 * A syntax selector on the type name is easy to get around with an alias, a
 * renamed import or a qualified name, so this rule asks the type checker whether
 * the target type carries a brand. Outside the mint files it reports:
 * - a cast (`as` or angle brackets) to any type that includes a brand;
 * - an explicit type argument that includes a brand, as in `brand<ModeratedText>(x)`;
 * - a type predicate that narrows to a brand;
 * - a cast to `never` or to a bare type parameter, which would launder any value.
 */
import { ESLintUtils } from '@typescript-eslint/utils';

const brandKeyPattern = /^__@(moderatedBrand|untrustedWebBrand)@/;

export default ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      brand:
        'ModeratedText and UntrustedWebText are minted only in guardrails/src/mint.ts and tools/src/untrusted.ts.',
      launder: 'Casting to never or to a bare type parameter can launder a value into any type.',
    },
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const program = services.program;
    const checker = program.getTypeChecker();

    /**
     * True if the type, or anything reachable through its members, type arguments
     * or union and intersection parts, carries a brand. Library types such as
     * Array or Promise are entered only through their type arguments.
     * @param {import('typescript').Type} type
     * @param {Set<import('typescript').Type>} seen
     * @returns {boolean}
     */
    function hasBrand(type, seen = new Set()) {
      if (seen.has(type) || seen.size > 200) return false;
      seen.add(type);
      if (type.isUnionOrIntersection() && type.types.some((t) => hasBrand(t, seen))) return true;
      const props = type.getProperties();
      if (props.some((p) => brandKeyPattern.test(String(p.escapedName)))) return true;
      const reference = /** @type {import('typescript').TypeReference} */ (type);
      if (reference.target !== undefined) {
        if (checker.getTypeArguments(reference).some((t) => hasBrand(t, seen))) return true;
      }
      const fromLib = type.symbol?.declarations?.some((d) =>
        program.isSourceFileDefaultLibrary(d.getSourceFile()),
      );
      if (fromLib === true) return false;
      return props.some((p) => hasBrand(checker.getTypeOfSymbol(p), seen));
    }

    /** @param {import('@typescript-eslint/utils').TSESTree.Node} node */
    const typeOf = (node) => checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));

    /** @param {import('@typescript-eslint/utils').TSESTree.TSAsExpression | import('@typescript-eslint/utils').TSESTree.TSTypeAssertion} node */
    function checkCast(node) {
      const target = node.typeAnnotation;
      if (
        target.type === 'TSTypeReference' &&
        target.typeName.type === 'Identifier' &&
        target.typeName.name === 'const'
      ) {
        return;
      }
      const type = typeOf(target);
      if (hasBrand(type)) {
        context.report({ node, messageId: 'brand' });
      } else if (target.type === 'TSNeverKeyword' || type.isTypeParameter()) {
        context.report({ node, messageId: 'launder' });
      }
    }

    return {
      TSAsExpression: checkCast,
      TSTypeAssertion: checkCast,
      TSTypeParameterInstantiation(node) {
        const parent = node.parent;
        if (parent.type !== 'CallExpression' && parent.type !== 'NewExpression') return;
        if (node.params.some((p) => hasBrand(typeOf(p)))) {
          context.report({ node, messageId: 'brand' });
        }
      },
      TSTypePredicate(node) {
        if (node.typeAnnotation && hasBrand(typeOf(node.typeAnnotation.typeAnnotation))) {
          context.report({ node, messageId: 'brand' });
        }
      },
    };
  },
});
