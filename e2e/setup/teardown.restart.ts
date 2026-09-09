import teardown from './global-teardown.mock';

export default async function () {
  try {
    await teardown();
  } finally {
    await fetch('http://127.0.0.1:4030/shutdown', {
      method: 'POST',
      headers: { 'x-e2e-control': 'synthetic-restart-control' },
      signal: AbortSignal.timeout(15_000),
    });
  }
}
