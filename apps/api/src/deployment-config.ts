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
