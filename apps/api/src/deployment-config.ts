const loopbackHosts = ['127.0.0.1', '::1', 'localhost'];

export function validateApiNetwork(
  apiHost: string,
  workerHost: string,
  privateCompose: boolean,
): void {
  if (!loopbackHosts.includes(apiHost) && !(privateCompose && apiHost === '0.0.0.0')) {
    throw new Error('The initial Omnis API must bind to loopback or private Compose networking.');
  }
  if (!loopbackHosts.includes(workerHost) && !(privateCompose && workerHost === 'worker')) {
    throw new Error('The worker target must use loopback or private Compose networking.');
  }
}

export function validateApiAuthorizerConfiguration(input: {
  restrictedDevelopment: boolean;
  token: string | undefined;
  internalToken?: string | undefined;
  socket: string | undefined;
}): void {
  if (input.restrictedDevelopment) {
    if (input.token || input.socket) {
      throw new Error(
        'Authorizer token and socket must be omitted in the restricted development profile.',
      );
    }
    return;
  }
  if (!input.token || input.token.length < 64 || input.token === input.internalToken) {
    throw new Error('A separate OMNIS_API_AUTHORIZER_TOKEN must be configured.');
  }
  if (!input.socket) {
    throw new Error('OMNIS_AUTHORIZER_SOCKET must be configured for Authorizer-backed operation.');
  }
}
