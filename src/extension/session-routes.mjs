export function createSessionRoutes(storageArea, storageKey = "agentBloomRoutes") {
  if (!storageArea?.get || !storageArea?.set) {
    throw new TypeError("A Chrome storage area is required");
  }

  async function readAll() {
    const stored = await storageArea.get(storageKey);
    const routes = stored?.[storageKey];
    return routes && typeof routes === "object" && !Array.isArray(routes) ? routes : {};
  }

  return Object.freeze({
    async save(requestId, route) {
      const routes = await readAll();
      await storageArea.set({ [storageKey]: { ...routes, [requestId]: route } });
    },

    async read(requestId) {
      if (!requestId) return null;
      const route = (await readAll())[requestId];
      return route && Number.isInteger(route.tabId) && Number.isInteger(route.frameId) ? route : null;
    },

    async delete(requestId) {
      if (!requestId) return;
      const routes = await readAll();
      if (!(requestId in routes)) return;
      const next = { ...routes };
      delete next[requestId];
      await storageArea.set({ [storageKey]: next });
    },
  });
}
