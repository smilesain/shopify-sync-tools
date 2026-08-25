import {
  definitionKey,
  isAppOwnedNamespace,
  isRestrictedNamespace,
} from './shopify-client.mjs';
import { metafieldDefinitionMatches } from './definition-filters.mjs';

const EXPORT_METAFIELD_DEFINITIONS = `
  query ExportMetafieldDefinitions($ownerType: MetafieldOwnerType!, $cursor: String) {
    metafieldDefinitions(ownerType: $ownerType, first: 250, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        namespace
        key
        description
        ownerType
        type {
          name
        }
        validations {
          name
          value
        }
        access {
          admin
          storefront
          customerAccount
        }
        capabilities {
          adminFilterable {
            enabled
          }
        }
      }
    }
  }
`;

const CREATE_METAFIELD_DEFINITION = `
  mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
        namespace
        key
        ownerType
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

function buildMetafieldDefinitionInput(definition, typeToTargetId, sourceTypeToId) {
  const validations = (definition.validations || []).map((validation) => {
    const remapped = remapMetaobjectValidation(validation, typeToTargetId, sourceTypeToId);

    if (remapped.remapStatus === 'UNRESOLVED' || remapped.remapStatus === 'MISSING_TARGET') {
      return null;
    }

    return {
      name: remapped.name,
      value: remapped.value,
    };
  }).filter(Boolean);

  const input = {
    name: definition.name,
    namespace: definition.namespace,
    key: definition.key,
    type: definition.type.name,
    description: definition.description || undefined,
    ownerType: definition.ownerType,
    validations,
  };

  if (definition.capabilities?.adminFilterable) {
    input.capabilities = {
      adminFilterable: {
        enabled: definition.capabilities.adminFilterable.enabled,
      },
    };
  }

  return input;
}

function hasUnresolvedValidations(definition, typeToTargetId, sourceTypeToId) {
  return (definition.validations || []).some((validation) => {
    if (validation.name !== 'metaobject_definition_id') {
      return false;
    }

    const remapped = remapMetaobjectValidation(validation, typeToTargetId, sourceTypeToId);
    return remapped.remapStatus === 'UNRESOLVED' || remapped.remapStatus === 'MISSING_TARGET';
  });
}

export async function exportMetafieldDefinitionsForOwnerType(client, ownerType) {
  return client.paginate(
    `metafieldDefinitions.${ownerType}`,
    EXPORT_METAFIELD_DEFINITIONS,
    { ownerType },
    (data) => data.metafieldDefinitions,
  );
}

export async function exportAllMetafieldDefinitions(client, ownerTypes) {
  const allDefinitions = [];

  for (const ownerType of ownerTypes) {
    const definitions = await exportMetafieldDefinitionsForOwnerType(client, ownerType);
    allDefinitions.push(...definitions);
    console.log(`[metafields] ${ownerType}: ${definitions.length} definition(s)`);
  }

  return allDefinitions;
}

export async function syncMetafieldDefinitions({
  sourceClient,
  targetClient,
  ownerTypes,
  dryRun,
  report,
  typeToTargetId,
  sourceTypeToId,
  keySelectors = [],
}) {
  console.log('\n[metafields] Exporting source definitions...');
  let sourceDefinitions = await exportAllMetafieldDefinitions(sourceClient, ownerTypes);

  console.log('[metafields] Exporting target definitions...');
  const targetDefinitions = await exportAllMetafieldDefinitions(targetClient, ownerTypes);

  if (keySelectors.length) {
    const filtered = sourceDefinitions.filter((definition) =>
      metafieldDefinitionMatches(definition, keySelectors),
    );
    for (const selector of keySelectors) {
      const found = sourceDefinitions.some((definition) => metafieldDefinitionMatches(definition, [selector]));
      if (!found) {
        report.metafields.failed.push({
          ownerType: selector.ownerType || '*',
          namespace: selector.namespace,
          key: selector.key,
          name: selector.raw,
          errors: [{ message: `Not found on source: ${selector.raw}` }],
        });
        console.log(`[metafields] Missing on source: ${selector.raw}`);
      }
    }
    console.log(`[metafields] Filter: ${filtered.length} of ${sourceDefinitions.length} definition(s)`);
    sourceDefinitions = filtered;
  }

  const targetKeys = new Set(
    targetDefinitions.map((definition) =>
      definitionKey(definition.ownerType, definition.namespace, definition.key),
    ),
  );

  report.metafields.sourceCount = sourceDefinitions.length;
  report.metafields.targetCount = targetDefinitions.length;

  for (const definition of sourceDefinitions) {
    const key = definitionKey(definition.ownerType, definition.namespace, definition.key);

    if (isAppOwnedNamespace(definition.namespace)) {
      report.metafields.skipped.push({
        ownerType: definition.ownerType,
        namespace: definition.namespace,
        key: definition.key,
        name: definition.name,
        reason: 'APP_OWNED',
        message: 'App-owned metafield definitions must be installed via the owning app.',
      });
      continue;
    }

    if (isRestrictedNamespace(definition.namespace)) {
      report.metafields.skipped.push({
        ownerType: definition.ownerType,
        namespace: definition.namespace,
        key: definition.key,
        name: definition.name,
        reason: 'SHOPIFY_RESERVED',
        message: 'Shopify reserved namespaces cannot be created via Custom App API.',
      });
      continue;
    }

    if (targetKeys.has(key)) {
      report.metafields.skipped.push({
        ownerType: definition.ownerType,
        namespace: definition.namespace,
        key: definition.key,
        name: definition.name,
        reason: 'ALREADY_EXISTS',
      });
      continue;
    }

    if (hasUnresolvedValidations(definition, typeToTargetId, sourceTypeToId)) {
      report.metafields.skipped.push({
        ownerType: definition.ownerType,
        namespace: definition.namespace,
        key: definition.key,
        name: definition.name,
        reason: 'UNRESOLVED_VALIDATION',
        message: 'Could not remap metaobject_definition_id validation to the target store.',
      });
      continue;
    }

    const input = buildMetafieldDefinitionInput(definition, typeToTargetId, sourceTypeToId);

    if (dryRun) {
      report.metafields.planned.push({
        ownerType: definition.ownerType,
        namespace: definition.namespace,
        key: definition.key,
        name: definition.name,
      });
      continue;
    }

    const payload = await targetClient.query(
      CREATE_METAFIELD_DEFINITION,
      { definition: input },
      { isMutation: true, allowErrors: true },
    );

    if (payload.errors?.length) {
      report.metafields.failed.push({
        ownerType: definition.ownerType,
        namespace: definition.namespace,
        key: definition.key,
        name: definition.name,
        errors: payload.errors.map((error) => ({ message: error.message })),
      });
      continue;
    }

    const result = payload.data.metafieldDefinitionCreate;
    const userErrors = result.userErrors || [];

    if (userErrors.length) {
      report.metafields.failed.push({
        ownerType: definition.ownerType,
        namespace: definition.namespace,
        key: definition.key,
        name: definition.name,
        errors: userErrors,
      });
      continue;
    }

    const created = result.createdDefinition;
    targetKeys.add(key);

    report.metafields.created.push({
      ownerType: created.ownerType,
      namespace: created.namespace,
      key: created.key,
      name: definition.name,
      id: created.id,
    });

    console.log(`[metafields] Created ${created.ownerType} ${created.namespace}.${created.key}`);
  }
}
