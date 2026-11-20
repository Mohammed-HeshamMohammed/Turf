// Illustrated avatars drawn as inline SVG, so people get a friendly face without any image files.
const BACKGROUNDS = ["#fbdfc2", "#d9e8c9", "#d6e3f0", "#eadcf0", "#f3d6d2", "#e9e2c4", "#cfe8e4", "#f1e0cf"];
const SKIN = ["#f6d5bd", "#e9b994", "#d19a73", "#a96f4c", "#7b4c32", "#f2c7a5"];
const HAIR = ["#2b2018", "#4a3020", "#7a5230", "#b98a4e", "#1d1d1d", "#8c8c8c", "#a8442a"];
const SHIRT = ["#805015", "#2c6a1e", "#3d5a80", "#6b4a8a", "#8a342b", "#44311d", "#2f6f6a"];

export const AVATAR_PRESETS = Array.from({ length: 12 }, (_, index) => "preset:" + (index + 1));

function hash(text) {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}
function pick(list, seed, salt) {
  return list[((seed >>> salt) & 255) % list.length];
}

function drawFace(seed) {
  const background = pick(BACKGROUNDS, seed, 0);
  const skin = pick(SKIN, seed, 4);
  const hair = pick(HAIR, seed, 8);
  const shirt = pick(SHIRT, seed, 12);
  const style = (seed >>> 16) % 5;
  const smile = (seed >>> 19) % 2 ? "M24 41 Q32 48 40 41" : "M25 42 Q32 46 39 42";
  const back =
    {
      0: `<path d="M16 30 Q16 10 32 10 Q48 10 48 30 L48 40 L16 40Z" fill="${hair}"/>`,
      3: `<path d="M14 26 Q14 8 32 8 Q50 8 50 26 L52 52 L12 52Z" fill="${hair}"/>`,
    }[style] || "";
  const front =
    {
      0: `<path d="M18 28 Q20 14 32 14 Q44 14 46 28 Q38 22 32 22 Q26 22 18 28Z" fill="${hair}"/>`,
      1: `<path d="M18 27 Q18 12 32 12 Q46 12 46 27 Q40 19 32 19 Q24 19 18 27Z" fill="${hair}"/>`,
      2: `<ellipse cx="32" cy="14" rx="15" ry="7" fill="${hair}"/><circle cx="32" cy="8" r="5" fill="${hair}"/>`,
      3: `<path d="M18 28 Q18 13 32 13 Q46 13 46 28 Q36 20 18 28Z" fill="${hair}"/>`,
      4: `<path d="M19 24 Q22 15 32 15 Q42 15 45 24 Q32 18 19 24Z" fill="${hair}"/>`,
    }[style] || "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" fill="${background}"/>` +
    back +
    `<path d="M8 64 Q10 48 32 48 Q54 48 56 64Z" fill="${shirt}"/>` +
    `<rect x="28" y="40" width="8" height="10" rx="3" fill="${skin}"/>` +
    `<ellipse cx="32" cy="29" rx="13" ry="14.5" fill="${skin}"/>` +
    front +
    `<circle cx="26.5" cy="30" r="1.7" fill="#2b2018"/><circle cx="37.5" cy="30" r="1.7" fill="#2b2018"/>` +
    `<path d="${smile}" stroke="#2b2018" stroke-width="1.6" fill="none" stroke-linecap="round" transform="translate(0 -3)"/>` +
    `</svg>`
  );
}

const PORTRAIT_FORMATS = ["jpg", "png", "webp"];

// The people on the sample team each get their own portrait; everyone else gets one chosen from their name.
const TEAM_PORTRAITS = {
  "Maya Chen": 1,
  "Ben Carter": 2,
  "Lena Brooks": 7,
  "Jordan Ellis": 4,
  "Alex Rivera": 8,
  "Taylor Reed": 9,
  "Sam Morgan": 6,
};

/**
 * Image sources to try, best first, for an avatar choice: an uploaded photo (data URL), otherwise a portrait from
 * public/avatars/ (1.jpg to 12.jpg; the person's own pick, or one chosen from their name), and finally a drawn face
 * so nothing is ever blank while the portraits are missing.
 */
export function avatarSources(choice, name) {
  if (typeof choice === "string" && choice.startsWith("data:image/")) return [choice];
  const preset = typeof choice === "string" && choice.startsWith("preset:") ? Number(choice.slice(7)) : 0;
  const number = preset || TEAM_PORTRAITS[name] || (hash(String(name || "?")) % AVATAR_PRESETS.length) + 1;
  const drawn = "data:image/svg+xml;utf8," + encodeURIComponent(drawFace(hash(preset ? choice + "-callerwhale" : String(name || "?"))));
  return [...PORTRAIT_FORMATS.map(format => `/avatars/${number}.${format}`), drawn];
}

/** Crops an uploaded image to a small square so it fits comfortably in local storage. */
export function squareAvatar(file, size = 160) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) return reject(new Error("Choose an image file."));
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const side = Math.min(image.width, image.height);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      canvas.getContext("2d").drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That image could not be read."));
    };
    image.src = url;
  });
}
