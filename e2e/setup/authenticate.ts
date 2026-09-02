import { chromium, request as playwrightRequest } from '@playwright/test';
import type { Browser, FullConfig, Page } from '@playwright/test';
import type { User } from '../types';
import cleanupUser from './cleanupUser';
import dotenv from 'dotenv';
if (process.env.E2E_HERMETIC_ENV !== 'true') {
  dotenv.config();
}

const timeout = Number(process.env.E2E_AUTH_TIMEOUT ?? 15000);
const chromiumChannel = process.env.E2E_CHROMIUM_CHANNEL || undefined;

async function register(page: Page, user: User) {
  await page.getByRole('link', { name: 'Sign up' }).click();
  await page.getByLabel('Full name').click();
  await page.getByLabel('Full name').fill(user.name);
  await page.getByLabel('Email').click();
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Email').press('Tab');
  await page.getByTestId('password').click();
  await page.getByTestId('password').fill(user.password);
  await page.getByTestId('confirm_password').click();
  await page.getByTestId('confirm_password').fill(user.password);
  await page.getByLabel('Submit registration').click();
}

async function registrationErrorIsVisible(page: Page) {
  return page
    .getByTestId('registration-error')
    .isVisible({ timeout: 500 })
    .catch(() => false);
}

async function login(page: Page, user: User) {
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByTestId('login-button').click();
}

function appURL(baseURL: string, pathname = '') {
  const normalizedBaseURL = baseURL.endsWith('/') ? baseURL : `${baseURL}/`;
  return new URL(pathname.replace(/^\/+/, ''), normalizedBaseURL).toString();
}

async function authenticateHermetic(
  browser: Browser,
  baseURL: string,
  storageState: string,
  user: User,
): Promise<void> {
  const api = await playwrightRequest.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
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
      throw new Error(`Hermetic E2E registration failed with status ${registration.status()}`);
    }
    const loginResponse = await api.post('/api/auth/login', {
      data: { email: user.email, password: user.password },
    });
    if (!loginResponse.ok()) {
      throw new Error(`Hermetic E2E login failed with status ${loginResponse.status()}`);
    }

    const context = await browser.newContext({ storageState: await api.storageState() });
    try {
      await context.addInitScript(() => localStorage.setItem('navVisible', 'true'));
      const page = await context.newPage();
      const conversationURL = appURL(baseURL, 'c/new');
      await page.goto(conversationURL, { timeout });
      await page.waitForURL(conversationURL, { timeout });
      await context.storageState({ path: storageState });
    } finally {
      await context.close();
    }
  } finally {
    await api.dispose();
  }
}

async function authenticate(config: FullConfig, user: User) {
  console.log('🤖: global setup has been started');
  const { baseURL, storageState } = config.projects[0].use;
  console.log('🤖: using baseURL', baseURL);
  console.log('🤖: using E2E user:', user.email);
  if (typeof storageState !== 'string') {
    throw new Error('🤖: storageState must be a file path');
  }

  const browser = await chromium.launch({
    headless: config.projects[0].use.headless ?? true,
    ...(chromiumChannel ? { channel: chromiumChannel } : {}),
  });
  try {
    console.log('🤖: 🗝  authenticating user:', user.email);

    if (typeof baseURL !== 'string') {
      throw new Error('🤖: baseURL is not defined');
    }
    if (process.env.E2E_HERMETIC_ENV === 'true') {
      await authenticateHermetic(browser, baseURL, storageState, user);
      console.log('🤖: ✔️  hermetic authentication state saved in', storageState);
      return;
    }

    const page = await browser.newPage();
    const conversationURL = appURL(baseURL, 'c/new');
    const loginURL = appURL(baseURL, 'login');

    // Set localStorage before navigating to the page
    await page.context().addInitScript(() => {
      localStorage.setItem('navVisible', 'true');
    });
    console.log('🤖: ✔️  localStorage: set Nav as Visible', storageState);

    await page.goto(baseURL, { timeout });
    await register(page, user);
    try {
      await page.waitForURL(conversationURL, { timeout });
    } catch (error) {
      console.error('Error:', error);
      if (await registrationErrorIsVisible(page)) {
        console.log('🤖: 🚨  user already exists');
        await cleanupUser(user);
        await page.goto(baseURL, { timeout });
        await register(page, user);
        await page.waitForURL(conversationURL, { timeout });
      } else {
        throw new Error('🤖: 🚨  user failed to register');
      }
    }
    console.log('🤖: ✔️  user successfully registered');

    await page.goto(loginURL, { timeout });
    await login(page, user);
    await page.waitForURL(conversationURL, { timeout });
    console.log('🤖: ✔️  user successfully authenticated');

    await page.context().storageState({ path: storageState });
    console.log('🤖: ✔️  authentication state successfully saved in', storageState);
    // await browser.close();
    // console.log('🤖: global setup has been finished');
  } finally {
    await browser.close();
    console.log('🤖: global setup has been finished');
  }
}

export default authenticate;
