import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { EMBEDDED } from "../lib/photos";
import { aerialPicture, embeddedPicture } from "../lib/service";

// Pictures saved in the project and aerial views, once fetched, are kept for as long as the window is open.
const resolved = new Map<string, string>();

async function source(photo: string): Promise<string> {
  if (!photo.startsWith(EMBEDDED)) return photo;
  const known = resolved.get(photo);
  if (known) return known;
  const { data_url } = await embeddedPicture(photo);
  resolved.set(photo, data_url);
  return data_url;
}

/**
 * A property's picture: each of its photos in turn (a link that no longer loads is skipped), then, where allowed, the
 * free USGS aerial view of its position, then a plain house icon. Photos load without telling their host which page
 * asked for them.
 */
export function PropertyPhoto({
  photos,
  position,
  label,
  aerial = false,
  borrowed = false,
  className,
}: {
  photos: string[];
  position?: [number, number] | null;
  label: string;
  aerial?: boolean;
  borrowed?: boolean;
  className?: string;
}) {
  const [index, setIndex] = useState(0);
  const [src, setSrc] = useState<string | null>(null);
  const [credit, setCredit] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const key = photos.join("\n");
  useEffect(() => {
    setIndex(0);
  }, [key]);

  useEffect(() => {
    let current = true;
    setSrc(null);
    setCredit(null);
    setWaiting(false);
    if (index < photos.length) {
      source(photos[index]).then(
        value => {
          if (current) setSrc(value);
        },
        () => {
          if (current) setIndex(next => next + 1);
        },
      );
      return () => {
        current = false;
      };
    }
    if (!aerial || !position)
      return () => {
        current = false;
      };
    const place = `aerial:${position[0].toFixed(5)},${position[1].toFixed(5)}`;
    const known = resolved.get(place);
    if (known) {
      setSrc(known);
      setCredit("Aerial view · USGS");
      return () => {
        current = false;
      };
    }
    let timer = 0;
    let tries = 0;
    const ask = () =>
      aerialPicture(position[0], position[1]).then(
        answer => {
          if (!current) return;
          if (answer.data_url) {
            resolved.set(place, answer.data_url);
            setSrc(answer.data_url);
            setCredit("Aerial view · USGS");
            setWaiting(false);
          } else if (answer.pending && tries++ < 30) {
            setWaiting(true);
            timer = window.setTimeout(ask, 2500);
          } else setWaiting(false);
        },
        () => {
          if (current) setWaiting(false);
        },
      );
    void ask();
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
    // The place is its two numbers, not the array that holds them, which is made anew on every draw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, key, aerial, position?.[0], position?.[1]]);

  return (
    <div className={`property-photo${className ? ` ${className}` : ""}`}>
      {src ? (
        <img src={src} alt={label} loading="lazy" referrerPolicy="no-referrer" onError={() => setIndex(next => next + 1)} />
      ) : (
        <span className="property-photo-empty" aria-label={waiting ? "Fetching the aerial view" : "No picture"}>
          <Icon name="home" size={36} />
          {waiting && <small>Fetching aerial view…</small>}
        </span>
      )}
      {src && (credit || borrowed) && <span className="property-photo-credit">{credit ?? "Photo from another list"}</span>}
    </div>
  );
}

/** Every photo of a property, a large one and the rest as thumbnails to pick from. */
export function PhotoGallery({
  photos,
  position,
  label,
  borrowed,
}: {
  photos: string[];
  position?: [number, number] | null;
  label: string;
  borrowed?: boolean;
}) {
  const [chosen, setChosen] = useState(0);
  const shown = photos.length
    ? [photos[Math.min(chosen, photos.length - 1)], ...photos.filter((_, index) => index !== Math.min(chosen, photos.length - 1))]
    : [];
  return (
    <div className="photo-gallery">
      <PropertyPhoto photos={shown} position={position} label={label} aerial borrowed={borrowed} className="large" />
      {photos.length > 1 && (
        <div className="photo-strip" role="list" aria-label="All photos">
          {photos.slice(0, 40).map((photo, index) => (
            <button
              key={photo}
              type="button"
              role="listitem"
              aria-pressed={index === chosen}
              aria-label={`Photo ${index + 1} of ${photos.length}`}
              onClick={() => setChosen(index)}
            >
              <PropertyPhoto photos={[photo]} label="" className="thumb-small" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
