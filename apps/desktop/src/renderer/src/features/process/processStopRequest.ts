type StopRequest = (id: string) => Promise<boolean>;
type StopErrorReporter = (id: string, message: string) => void;
type StopSuccessReporter = (id: string) => void;

/** Consume stop-request failures so an IPC rejection is visible and never unhandled. */
export function requestManagedProcessStop(
  request: StopRequest,
  id: string,
  reportError: StopErrorReporter,
  onSuccess?: StopSuccessReporter | undefined,
): Promise<void> {
  return Promise.resolve()
    .then(() => request(id))
    .then((stopped) => {
      if (!stopped) {
        throw new Error(
          "Process was no longer tracked or already exited; termination was not confirmed.",
        );
      }
      onSuccess?.(id);
    })
    .catch((error: unknown) => {
      reportError(id, error instanceof Error ? error.message : String(error));
    });
}
