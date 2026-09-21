export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
      'X-DukanOS-Request': '1',
    },
    body:
      body instanceof FormData
        ? body
        : body === undefined
          ? undefined
          : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({
      code: 'REQUEST_FAILED',
      message: 'The request could not be completed.',
    }));
    throw new ApiFailure(response.status, error.code, error.message);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
export const errorMessage = (error: unknown) =>
  error instanceof ApiFailure
    ? error.message
    : 'Cannot reach the server. Check your connection and try again.';
