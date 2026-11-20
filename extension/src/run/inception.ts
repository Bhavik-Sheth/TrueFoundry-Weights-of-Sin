// Connection details sent to TrueForge when the user saves the provider.
export const inception = {
  name: 'inception',
  baseUrl: 'https://api.inceptionlabs.ai/v1',
  model: 'mercury-3',
} as const;
export const inceptionModel = `${inception.name}/${inception.model}`;
