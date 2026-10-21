import { useToast } from '@/hooks/use-toast';

/**
 * Turning the server's error envelope ({ error: { code, message } }) into
 * something a person can read. Each page passes titles for the refusal codes it
 * can meet; the server's message is always the description.
 */

export type ErrorTitles = Record<string, string>;

export type DescribedError = { title: string; message: string };

/** The error code from an API error, if the server sent one. */
export function errorCode(error: any): string | undefined {
  return error?.data?.error?.code;
}

export function describeError(error: any, fallback: string, titles: ErrorTitles = {}): DescribedError {
  const code = errorCode(error);
  return {
    title: (code && titles[code]) || 'Something went wrong',
    message: error?.data?.error?.message || fallback,
  };
}

/** A destructive toast for a failed request, titled from `titles` by error code. */
export function useApiErrorToast(titles: ErrorTitles = {}) {
  const { toast } = useToast();
  return (error: any, fallback: string) => {
    const { title, message } = describeError(error, fallback, titles);
    toast({ title, description: message, variant: 'destructive' });
  };
}
