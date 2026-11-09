const disposableDatabaseCredentials = [
  'omnis_test_password',
  'omnis_migration_test_password_2026',
  'omnis_runtime_test_password_2026',
  'omnis_authorizer_test_password_2026',
  'omnis_launcher_test_password_2026',
];

export function getGitHubMaskCommands(credentials = disposableDatabaseCredentials) {
  return credentials.map((credential) => `::add-mask::${credential}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const command of getGitHubMaskCommands()) process.stdout.write(`${command}\n`);
}
