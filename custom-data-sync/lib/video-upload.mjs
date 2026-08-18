const STAGED_UPLOADS_CREATE = `
  mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`;

const FILE_CREATE = `
  mutation FileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { __typename id ... on Video { filename originalSource { url } } }
      userErrors { field message code }
    }
  }
`;

export async function downloadVideoBuffer(sourceUrl) {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${sourceUrl}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function uploadVideoViaStagedTarget(targetClient, { filename, buffer, alt = '' }) {
  const stagedPayload = await targetClient.query(
    STAGED_UPLOADS_CREATE,
    {
      input: [
        {
          filename,
          mimeType: 'video/mp4',
          resource: 'VIDEO',
          fileSize: String(buffer.byteLength),
          httpMethod: 'POST',
        },
      ],
    },
    { isMutation: true },
  );

  const stagedResult = stagedPayload.data?.stagedUploadsCreate;
  if (stagedResult?.userErrors?.length) {
    throw new Error(stagedResult.userErrors.map((e) => e.message).join('; '));
  }

  const target = stagedResult?.stagedTargets?.[0];
  if (!target) throw new Error('No staged upload target returned');

  const form = new FormData();
  for (const param of target.parameters) {
    form.append(param.name, param.value);
  }
  form.append('file', new Blob([buffer], { type: 'video/mp4' }), filename);

  const uploadResponse = await fetch(target.url, { method: 'POST', body: form });
  if (!uploadResponse.ok) {
    const body = await uploadResponse.text();
    throw new Error(`Staged upload failed (${uploadResponse.status}): ${body.slice(0, 200)}`);
  }

  const createPayload = await targetClient.query(
    FILE_CREATE,
    {
      files: [
        {
          alt,
          contentType: 'VIDEO',
          originalSource: target.resourceUrl,
        },
      ],
    },
    { isMutation: true, allowErrors: true },
  );

  const createResult = createPayload.data?.fileCreate;
  if (createPayload.errors?.length) {
    throw new Error(createPayload.errors.map((e) => e.message).join('; '));
  }
  if (createResult?.userErrors?.length) {
    throw new Error(createResult.userErrors.map((e) => e.message).join('; '));
  }
  return createResult.files[0];
}
