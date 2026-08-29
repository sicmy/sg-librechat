import { request as playwrightRequest } from '@playwright/test';
import type { FullConfig } from '@playwright/test';
import cleanupUser from './cleanupUser';
import { getE2EUser } from './user';

async function globalSetup(config: FullConfig): Promise<void> {
  const { baseURL, storageState } = config.projects[0].use;
  if (typeof baseURL !== 'string' || typeof storageState !== 'string') {
    throw new Error('Phase 1 E2E requires string baseURL and storageState settings');
  }

  const user = getE2EUser();
  await cleanupUser(user);

  const api = await playwrightRequest.newContext({ baseURL });
  try {
    const registration = await api.post('/api/auth/register', {
      data: {
        email: user.email,
        name: user.name,
        password: user.password,
        confirm_password: user.password,
      },
    });
    if (!registration.ok()) {
      throw new Error(`Phase 1 admin registration failed with ${registration.status()}`);
    }

    const login = await api.post('/api/auth/login', {
      data: { email: user.email, password: user.password },
    });
    if (!login.ok()) {
      throw new Error(`Phase 1 admin login failed with ${login.status()}`);
    }
    await api.storageState({ path: storageState });
  } finally {
    await api.dispose();
  }
}

export default globalSetup;
