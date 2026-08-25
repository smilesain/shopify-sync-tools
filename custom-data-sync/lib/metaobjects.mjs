import { isAppOwnedMetaobjectType, isRestrictedMetaobjectType, metaobjectTypeKey } from './shopify-client.mjs';

const EXPORT_METAOBJECT_DEFINITIONS = `
  query ExportMetaobjectDefinitions($cursor: String) {
    metaobjectDefinitions(first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        type
        description
        displayNameKey
        fieldDefinitions {
          key
          name
          description
          required
          type {
            name
          }
          validations {
            name
            value
          }
        }
        access {
          admin
          storefront
        }
        capabilities {
          publishable {
            enabled
          }
          translatable {
            enabled
          }
        }
      }
    }
  }
`;

const CREATE_METAOBJECT_DEFINITION = `
  mutation CreateMetaobjectDefinition($definition: MetaobjectDefinitionCreateInput!) {
    metaobjectDefinitionCreate(definition: $definition) {
      metaobjectDefinition {
        id
        type
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

function buildFieldDefinitions(fieldDefinitions) {
  return fieldDefinitions.map((field) => ({
    key: field.key,
    name: field.name,
    description: field.description || undefined,
    required: field.required,
    type: field.type.name,
    validations: (field.validations || []).map((validation) => ({
      name: validation.name,
      value: validation.value,
    })),
  }));
}

function normalizeMetaobjectStorefrontAccess(value) {
  if (!value) return undefined;

  const normalized = String(value).toUpperCase();

  if (normalized === 'PUBLIC_READ' || normalized === 'NONE') {
    return normalized;
  }

  return undefined;
}

function buildMetaobjectDefinitionInput(definition) {
  const input = {
    type: definition.type,
    name: definition.name,
    description: definition.description || undefined,
    displayNameKey: definition.displayNameKey || undefined,
    fieldDefinitions: buildFieldDefinitions(definition.fieldDefinitions || []),
  };

  if (definition.access) {
    const storefront = normalizeMetaobjectStorefrontAccess(definition.access.storefront);

    if (storefront) {
      input.access = { storefront };
    }
  }

  if (definition.capabilities) {
    input.capabilities = {};

    if (definition.capabilities.publishable) {
      input.capabilities.publishable = {
        enabled: definition.capabilities.publishable.enabled,
      };
    }

    if (definition.capabilities.translatable) {
      input.capabilities.translatable = {
        enabled: definition.capabilities.translatable.enabled,
      };
    }
  }

  return input;
}

export async function exportMetaobjectDefinitions(client) {
  return client.paginate(
    'metaobjectDefinitions',
    EXPORT_METAOBJECT_DEFINITIONS,
    {},
    (data) => data.metaobjectDefinitions,
  );
}

export async function syncMetaobjectDefinitions({
  sourceClient,
  targetClient,
  dryRun,
  report,
  typeFilters = [],
}) {
  console.log('\n[metaobjects] Exporting source definitions...');
  let sourceDefinitions = await exportMetaobjectDefinitions(sourceClient);

  console.log('[metaobjects] Exporting target definitions...');
  const targetDefinitions = await exportMetaobjectDefinitions(targetClient);

  if (typeFilters.length) {
    const wanted = [...new Set(typeFilters.map((type) => metaobjectTypeKey(type)))];
    const filtered = sourceDefinitions.filter((definition) =>
      wanted.includes(metaobjectTypeKey(definition.type)),
    );
    const found = new Set(filtered.map((definition) => metaobjectTypeKey(definition.type)));
    for (const type of wanted) {
      if (!found.has(type)) {
        report.metaobjects.failed.push({
          type,
          name: type,
          errors: [{ message: `Not found on source: ${type}` }],
        });
        console.log(`[metaobjects] Missing on source: ${type}`);
      }
    }
    console.log(`[metaobjects] Filter: ${filtered.length} of ${sourceDefinitions.length} definition(s)`);
    sourceDefinitions = filtered;
  }

  const targetByType = new Map(
    targetDefinitions.map((definition) => [metaobjectTypeKey(definition.type), definition]),
  );

  const typeToTargetId = new Map(
    targetDefinitions.map((definition) => [metaobjectTypeKey(definition.type), definition.id]),
  );

  report.metaobjects.sourceCount = sourceDefinitions.length;
  report.metaobjects.targetCount = targetDefinitions.length;

  for (const definition of sourceDefinitions) {
    const typeKey = metaobjectTypeKey(definition.type);

    if (isAppOwnedMetaobjectType(definition.type)) {
      report.metaobjects.skipped.push({
        type: definition.type,
        name: definition.name,
        reason: 'APP_OWNED',
        message: 'App-owned metaobject definitions must be installed via the owning app.',
      });
      continue;
    }

    if (isRestrictedMetaobjectType(definition.type)) {
      report.metaobjects.skipped.push({
        type: definition.type,
        name: definition.name,
        reason: 'SHOPIFY_RESERVED',
        message: 'Shopify reserved metaobject types cannot be created via Custom App API.',
      });
      continue;
    }

    if (targetByType.has(typeKey)) {
      typeToTargetId.set(typeKey, targetByType.get(typeKey).id);
      report.metaobjects.skipped.push({
        type: definition.type,
        name: definition.name,
        reason: 'ALREADY_EXISTS',
      });
      continue;
    }

    const input = buildMetaobjectDefinitionInput(definition);

    if (dryRun) {
      report.metaobjects.planned.push({
        type: definition.type,
        name: definition.name,
      });
      continue;
    }

    const payload = await targetClient.query(
      CREATE_METAOBJECT_DEFINITION,
      { definition: input },
      { isMutation: true, allowErrors: true },
    );

    if (payload.errors?.length) {
      report.metaobjects.failed.push({
        type: definition.type,
        name: definition.name,
        errors: payload.errors.map((error) => ({ message: error.message })),
      });
      continue;
    }

    const result = payload.data.metaobjectDefinitionCreate;
    const userErrors = result.userErrors || [];

    if (userErrors.length) {
      report.metaobjects.failed.push({
        type: definition.type,
        name: definition.name,
        errors: userErrors,
      });
      continue;
    }

    const created = result.metaobjectDefinition;
    typeToTargetId.set(typeKey, created.id);
    targetByType.set(typeKey, created);

    report.metaobjects.created.push({
      type: created.type,
      name: definition.name,
      id: created.id,
    });

    console.log(`[metaobjects] Created ${definition.type}`);
  }

  return {
    sourceDefinitions,
    targetDefinitions,
    typeToTargetId,
  };
}

export function remapMetaobjectValidation(validation, typeToTargetId, sourceTypeToId) {
  if (validation.name !== 'metaobject_definition_id') {
    return validation;
  }

  const sourceDefinitionId = validation.value;
  const sourceType = [...sourceTypeToId.entries()].find(([, id]) => id === sourceDefinitionId)?.[0];

  if (!sourceType) {
    return {
      ...validation,
      remapStatus: 'UNRESOLVED',
    };
  }

  const targetDefinitionId = typeToTargetId.get(sourceType);

  if (!targetDefinitionId) {
    return {
      ...validation,
      remapStatus: 'MISSING_TARGET',
    };
  }

  return {
    name: validation.name,
    value: targetDefinitionId,
    remapStatus: 'REMAPPED',
  };
}

export function buildSourceMetaobjectIdMap(definitions) {
  return new Map(definitions.map((definition) => [metaobjectTypeKey(definition.type), definition.id]));
}
