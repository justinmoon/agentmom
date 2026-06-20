export function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readJsonResponse(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${response.url}, got: ${text.slice(0, 120)}`);
  }
}
