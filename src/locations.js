const VENUES = new Map(
  [
    ["AKRON", "Guadalajara", "Estadio Akron Guadalajara"],
    ["AT&T Stadium", "Dallas", "AT&T Stadium Dallas"],
    ["Arrowhead Stadium", "Kansas City", "Arrowhead Stadium Kansas City"],
    ["Azteca", "Mexico City", "Estadio Azteca Mexico City"],
    ["BC Place", "Vancouver", "BC Place Vancouver"],
    ["BMO Field", "Toronto", "BMO Field Toronto"],
    ["Estadio BBVA", "Monterrey", "Estadio BBVA Monterrey"],
    ["Gillette Stadium", "Boston", "Gillette Stadium Boston"],
    ["Hard Rock Stadium", "Miami", "Hard Rock Stadium Miami"],
    ["Levi's Stadium", "San Francisco Bay Area", "Levi's Stadium Santa Clara"],
    ["Lincoln Financial Field", "Philadelphia", "Lincoln Financial Field Philadelphia"],
    ["Lumen Field", "Seattle", "Lumen Field Seattle"],
    ["Mercedes-Benz Stadium", "Atlanta", "Mercedes-Benz Stadium Atlanta"],
    ["MetLife Stadium", "New York New Jersey", "MetLife Stadium New York New Jersey"],
    ["NRG Stadium", "Houston", "NRG Stadium Houston"],
    ["SoFi Stadium", "Los Angeles", "SoFi Stadium Los Angeles"],
  ].map(([venue, city, query]) => [venueKey(venue), { venue, city, query }]),
);

export function locationForVenue(venue) {
  const key = venueKey(venue);
  if (!key) return null;

  const known = VENUES.get(key);
  if (known) return withMapUrl(known);

  const value = String(venue).trim();
  return withMapUrl({ venue: value, city: "", query: value });
}

export function locationForMatch(match) {
  const venue = match?.venue ?? "";
  const city = match?.city ?? "";
  const mapUrl = match?.mapUrl ?? match?.mapsUrl ?? "";
  if (city || mapUrl) {
    return {
      venue,
      city,
      mapUrl: mapUrl || googleMapsUrl([venue, city].filter(Boolean).join(" ")),
    };
  }
  return locationForVenue(venue);
}

function withMapUrl(location) {
  return { ...location, mapUrl: googleMapsUrl(location.query) };
}

function googleMapsUrl(query) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function venueKey(venue) {
  return String(venue ?? "")
    .trim()
    .toLowerCase()
    .replace(/^estadio akron$/, "akron")
    .replace(/^estadio azteca$/, "azteca")
    .replace(/[\s._-]+/g, " ");
}
