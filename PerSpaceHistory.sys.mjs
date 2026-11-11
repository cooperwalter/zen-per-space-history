import * as GeckoCompat from "./lib/GeckoCompat.sys.mjs";
import { createPerSpaceHistory } from "./lib/Core.sys.mjs";

export const PerSpaceHistory = createPerSpaceHistory(GeckoCompat);

PerSpaceHistory.init();
