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
 * - a bodiless function signature (an overload or a `declare function`) and an
 *   ambient `declare` variable or class whose type includes a brand, since each
 *   asserts a branded value without producing one;
 * - a cast whose target contains `never` or a type parameter anywhere, which
 *   could launder any value into any type.
 *
 * This is a tripwire for the forms in its fixtures, not a proof: TypeScript has
 * no way to make a brand unforgeable. The route-inventory test and review carry
 * the end-to-end guarantee.
 */
import { ESLintUtils } from '@typescript-eslint/utils';
import ts from 'typescript';

const brandKeyPattern = /^__@(moderatedBrand|untrustedWebBrand)@/;

export default ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      brand:
        'ModeratedText and UntrustedWebText are minted only in guardrails/src/mint.ts and tools/src/untrusted.ts.',
      launder:
        'A cast whose target contains never or a type parameter can launder a value into any type.',
    },
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const program = services.program;
    const checker = program.getTypeChecker();

    /**
     * True if `test` holds for the type or for anything reachable through its
     * union and intersection parts, type arguments, members and the return types
     * of its call and construct signatures. Library types such as Array or
     * Promise are entered only through their type arguments.
     * @param {import('typescript').Type} type
     * @param {(t: import('typescript').Type) => boolean} test
     * @param {Set<import('typescript').Type>} seen
     * @returns {boolean}
     */
    function someType(type, test, seen = new Set()) {
      if (seen.has(type) || seen.size > 300) return false;
      seen.add(type);
      if (test(type)) return true;
      const walk = (/** @type {import('typescript').Type} */ t) => someType(t, test, seen);
      if (type.isUnionOrIntersection() && type.types.some(walk)) return true;
      const reference = /** @type {import('typescript').TypeReference} */ (type);
      if (reference.target !== undefined && checker.getTypeArguments(reference).some(walk)) {
        return true;
      }
      const fromLib = type.symbol?.declarations?.some((d) =>
        program.isSourceFileDefaultLibrary(d.getSourceFile()),
      );
      if (fromLib === true) return false;
      if (type.getProperties().some((p) => walk(checker.getTypeOfSymbol(p)))) return true;
      const signatures = [...type.getCallSignatures(), ...type.getConstructSignatures()];
      return signatures.some((sig) => walk(checker.getReturnTypeOfSignature(sig)));
    }

    /** @param {import('typescript').Type} t */
    const isBrand = (t) =>
      t.getProperties().some((p) => brandKeyPattern.test(String(p.escapedName)));
    /** @param {import('typescript').Type} t */
    const isLaunder = (t) => (t.flags & ts.TypeFlags.Never) !== 0 || t.isTypeParameter();
    /** @param {import('typescript').Type} t */
    const hasBrand = (t) => someType(t, isBrand);

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
      } else if (someType(type, isLaunder)) {
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
      TSDeclareFunction(node) {
        const returnType = node.returnType?.typeAnnotation;
        if (returnType !== undefined && hasBrand(typeOf(returnType))) {
          context.report({ node, messageId: 'brand' });
        }
      },
      VariableDeclaration(node) {
        if (!node.declare) return;
        for (const declarator of node.declarations) {
          if (hasBrand(typeOf(declarator.id))) {
            context.report({ node: declarator, messageId: 'brand' });
          }
        }
      },
      ClassDeclaration(node) {
        if (!node.declare || node.id === null) return;
        // The static side (typeof G), whose construct signature also reaches the instance members.
        const symbol = checker.getSymbolAtLocation(services.esTreeNodeToTSNodeMap.get(node.id));
        if (symbol !== undefined && hasBrand(checker.getTypeOfSymbol(symbol))) {
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
