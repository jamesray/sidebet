export const search = (items, query) =>
  items.filter((item) => item.name.includes(query))
