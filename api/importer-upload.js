// "Upload packing list" (requirements "In-Transit" §6, TBD-I04): creates the item of In-Transit / Wholesale Importer
// (18404604646) with the fields of the board's "Importer Form", for authenticated, whitelisted users (see _auth.js).
//   GET  → the monday people that can be picked for People ({ users: [{ id, name, photo }], me }).
//   POST multipart/form-data: name, file, typeImport (In-Transit | In-Transit Draft), people (user ids, comma
//        separated), location (US | AU), etd, eta (YYYY-MM-DD) → { ok, itemId }.
// Order (PROCESO-in-transit, automation 2): create the item with its columns → attach the file → only then set
// Import Status = "Import", which is what starts monday's import (it validates File, People, Location, ETD and Type
// Import itself). ?dry=1 validates and answers what it would write, without writing anything.

import { guarded, serverMonday } from "./_auth.js";
import { invalidateParts } from "./_cache.js";

const BOARD = "18404604646";
const GROUP = "topics";
const COL = { file: "file_mm1kn5sf", type: "color_mm1kk5v5", status: "status", people: "multiple_person_mm4ejhxq", location: "color_mm4etbyd", etd: "date_mm4evprw", eta: "date_mm4ee89a" };
const TYPES = ["In-Transit", "In-Transit Draft"];
const LOCATIONS = ["US", "AU"];
const MAX_BYTES = 4 * 1024 * 1024; // Vercel functions accept bodies up to 4.5 MB
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export const GET = guarded(async (_request, { user }) => {
  // photo: the monday avatar (a photo, or monday's own image with the person's initials and color).
  const d = await serverMonday(`{ users(limit:500, kind:non_guests){ id name enabled photo_tiny } }`);
  const users = (d?.users || []).filter((u) => u.enabled).map((u) => ({ id: String(u.id), name: u.name, photo: u.photo_tiny || "" })).sort((a, b) => a.name.localeCompare(b.name));
  return json(200, { users, me: user.userId });
});

export const POST = guarded(async (request, { user }) => {
  const dry = new URL(request.url).searchParams.get("dry") === "1";
  let form;
  try {
    form = await request.formData();
  } catch {
    return json(400, { error: "Send the form as multipart/form-data." });
  }
  const f = (k) => String(form.get(k) || "").trim();
  const file = form.get("file");
  const name = f("name"), typeImport = f("typeImport"), location = f("location"), etd = f("etd"), eta = f("eta");
  const people = f("people").split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x));
  const missing = [];
  if (!name) missing.push("Name");
  if (!file || typeof file === "string" || !file.size) missing.push("File");
  if (!TYPES.includes(typeImport)) missing.push("Type Import");
  if (!people.length) missing.push("People");
  if (!LOCATIONS.includes(location)) missing.push("Location");
  if (!isDate(etd)) missing.push("ETD");
  if (eta && !isDate(eta)) missing.push("ETA (a date)");
  if (missing.length) return json(400, { error: `Missing or invalid: ${missing.join(", ")}.` });
  if (file.size > MAX_BYTES) return json(413, { error: "The file is larger than 4 MB. Upload it with the form in Monday instead." });

  const values = {
    [COL.type]: { label: typeImport },
    [COL.location]: { label: location },
    [COL.etd]: { date: etd },
    ...(eta ? { [COL.eta]: { date: eta } } : {}),
    [COL.people]: { personsAndTeams: people.map((id) => ({ id: Number(id), kind: "person" })) },
  };
  if (dry) return json(200, { ok: true, dry: true, name, file: { name: file.name, size: file.size }, values, then: { [COL.status]: { label: "Import" } } });

  // 1. The item, with every field but the file and Import Status.
  const created = await serverMonday(
    `mutation($b:ID!,$g:String!,$n:String!,$v:JSON!){ create_item(board_id:$b, group_id:$g, item_name:$n, column_values:$v, create_labels_if_missing:false){ id } }`,
    { b: BOARD, g: GROUP, n: name, v: JSON.stringify(values) },
  ).catch((e) => ({ error: e.message }));
  const itemId = created?.create_item?.id;
  if (!itemId) return json(502, { error: `Monday did not create the item: ${created?.error || "no id"}.` });

  // 2. The packing list, on the File column.
  const up = new FormData();
  up.append("query", `mutation($file: File!){ add_file_to_column(item_id:${Number(itemId)}, column_id:"${COL.file}", file:$file){ id } }`);
  up.append("variables[file]", file, file.name || "packing-list");
  const fileRes = await fetch("https://api.monday.com/v2/file", { method: "POST", headers: { Authorization: process.env.MONDAY_TOKEN }, body: up })
    .then((r) => r.json()).catch((e) => ({ errors: [{ message: e.message }] }));
  if (!fileRes?.data?.add_file_to_column?.id) {
    const why = fileRes?.errors?.map((e) => e.message).join(" | ") || fileRes?.error_message || "unknown error";
    return json(502, { error: `The item was created but the file could not be attached (${why}). Attach it in Monday and set Import Status to Import.`, itemId });
  }

  // 3. Import Status = Import: starts monday's import.
  const started = await serverMonday(
    `mutation($b:ID!,$i:ID!,$v:JSON!){ change_column_value(board_id:$b, item_id:$i, column_id:"${COL.status}", value:$v){ id } }`,
    { b: BOARD, i: itemId, v: JSON.stringify({ label: "Import" }) },
  ).catch((e) => ({ error: e.message }));
  if (!started?.change_column_value?.id) return json(502, { error: `The file is in Monday but the import did not start (${started?.error || "no answer"}). Set Import Status to Import in Monday.`, itemId });

  console.info(`[importer-upload] "${name}" (${file.name}, ${file.size} B) → item ${itemId}, by ${user.name} (${user.userId})`);
  await invalidateParts(["imports"]);
  return json(200, { ok: true, itemId });
});
