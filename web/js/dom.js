// DOM helpers: the kit's (h(), icon()…), with Get Done's icons registered,
// plus what only Get Done needs.

import { registerIcons } from '/kit/js/dom.js';
import { Icons } from './icons.js';

export { h, icon, clear, isMobile, isTextInput, autoGrow, debounce } from '/kit/js/dom.js';

registerIcons(Icons);

export function mapsUrl(location) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
}
