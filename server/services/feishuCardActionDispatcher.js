export function createFeishuCardActionDispatcher({ dispatch = queueMicrotask, onError = console.error } = {}) {
  return function dispatchFeishuCardAction(response, handler) {
    dispatch(async () => {
      try {
        await handler();
      } catch (error) {
        onError(error);
      }
    });

    return response;
  };
}
