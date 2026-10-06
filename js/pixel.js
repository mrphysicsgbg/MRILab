// Canvas CSS dimensions differ from the phantom dimensions. Keep row 0 at top.
export function pixelAt(clientX, clientY, bounds, width, height) {
  if (bounds.width <= 0 || bounds.height <= 0 || clientX < bounds.left || clientY < bounds.top
    || clientX >= bounds.left + bounds.width || clientY >= bounds.top + bounds.height) return null;
  const column = Math.floor((clientX - bounds.left) * width / bounds.width);
  const row = Math.floor((clientY - bounds.top) * height / bounds.height);
  return { column, row, index: row * width + column };
}
