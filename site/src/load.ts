// A variable specifier, so Vite leaves it to the page's import map
export const load = <T>(specifier: string): Promise<T> => import(/* @vite-ignore */ specifier);
