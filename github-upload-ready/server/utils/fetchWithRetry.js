function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export async function fetchWithRetry(url, options = {}, retryOptions = {}) {
  const retries = retryOptions.retries ?? envNumber('HTTP_RETRY_COUNT', 2);
  const baseDelayMs = retryOptions.baseDelayMs ?? envNumber('HTTP_RETRY_BASE_DELAY_MS', 500);
  const timeoutMs = retryOptions.timeoutMs ?? envNumber('HTTP_TIMEOUT_MS', 60000);
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!shouldRetryStatus(response.status) || attempt === retries) {
        return response;
      }

      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      clearTimeout(timeout);
      lastError = error.name === 'AbortError' ? new Error(`请求超时：${timeoutMs}ms`) : error;

      if (attempt === retries) {
        throw lastError;
      }
    }

    const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 100);
    await sleep(delay);
  }

  throw lastError || new Error('请求失败');
}
