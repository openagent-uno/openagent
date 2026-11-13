import { ref } from "vue";
import { fetchCatalogue, type Release } from "./release-catalog";

// One browser-side load shared by every download section and client navigation.
// Mounting again after a minute refreshes the catalogue without a site rebuild.
const releases = ref<Release[]>([]);
const loading = ref(true);
const error = ref("");
let pending: Promise<void> | null = null;
let loadedAt = 0;

export function useReleaseCatalogue() {
  async function load(force = false): Promise<void> {
    if (pending) return pending;
    if (!force && loadedAt && Date.now() - loadedAt < 60_000) return;
    loading.value = true; error.value = "";
    pending = fetchCatalogue().then(value => { releases.value = value; loadedAt = Date.now(); })
      .catch(() => { releases.value = []; error.value = "Release lookup is temporarily unavailable."; })
      .finally(() => { loading.value = false; pending = null; });
    return pending;
  }
  return { releases, loading, error, load };
}
