// Compila el favorito y lo inserta en index.html (entre los marcadores BOOKMARKLET).
// Uso: npm install --no-save esbuild && node favorito/build.mjs
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
const dir = path.dirname(new URL(import.meta.url).pathname);
const out = await build({ entryPoints: [path.join(dir, "enviar-a-visitas.src.mjs")], bundle: true, minify: true, format: "iife", target: "es2020", write: false, charset: "utf8", legalComments: "none" });
const code = out.outputFiles[0].text.trim();
fs.writeFileSync(path.join(dir, "enviar-a-visitas.min.js"), code);
const idx = path.join(dir, "..", "index.html");
const html = fs.readFileSync(idx, "utf8");
const literal = JSON.stringify(code).replace(/<\//g, "<\\/");
const next = html.replace(/\/\*BOOKMARKLET\*\/[\s\S]*?\/\*FIN_BOOKMARKLET\*\//, () => `/*BOOKMARKLET*/${literal}/*FIN_BOOKMARKLET*/`); // función: evita que "$1" del código se interprete
if (next === html && !html.includes("/*BOOKMARKLET*/")) throw new Error("No se encontró el marcador BOOKMARKLET en index.html");
fs.writeFileSync(idx, next);
console.log("Favorito compilado:", code.length, "caracteres");
