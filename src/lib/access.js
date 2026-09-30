// Access control shared by the browser and the server.
// Whitelist board: "🔐 Allocation Matrix — Access List" (private, workspace ETOILE).
// One item per monday user; only Status = "Active" gets in. Role: "Admin" | "Member".

export const ACCESS_LIST = {
  board: "18433468057",
  col: {
    status: "color_mm7pnmd5",
    role: "color_mm7pedgt",
    userId: "text_mm7psrzp",
    email: "text_mm7pwepk",
    person: "multiple_person_mm7pac0m",
    lastAccess: "date_mm7pvvta",
    notes: "text_mm7pef20",
  },
  ACTIVE: "Active",
};

// People column of the Wholesale subitem (the sale line): who saved shipments of that line.
export const LINE_PEOPLE_COLUMN = "multiple_person_mm7pdm50";

// Always the same, generic answer — never say why (unknown user, inactive, wrong account…).
export const NOT_AUTHORIZED_MESSAGE = "You don't have access to this application. Contact your administrator.";
