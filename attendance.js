// Adds a "75% plan" column beside attendance tables on PESU Academy.
// For each row it works out how many classes can be skipped (when already at or
// above 75%) or how many must be attended in a row (when below 75%).
(function () {
  "use strict";

  if (window.__pesuAttendanceHelper) return;
  window.__pesuAttendanceHelper = true;

  const TARGET = 0.75;
  const PLAN_ATTR = "data-pesu-plan";

  const clean = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();

  /* ───────────── reading the table ───────────── */

  // Header names on the attendance page differ between semesters ("Classes
  // Attended", "Attended", "Present", "Att. %", …). Classify them by keyword.
  function roleFor(raw) {
    const text = clean(raw).toLowerCase();
    if (!text) return "";

    // "Attendance %", "Percentage(%)", "Att. %" and plain "%" are all the
    // percentage column.
    if (/%/.test(text) || /percent/.test(text)) return "pct";
    if (/(attended|present)/.test(text)) return "attended";
    if (/(conducted|delivered|held|taken|total)/.test(text)) return "total";
    // A bare "Attendance" column is almost always the percentage.
    if (/attend/.test(text)) return "pct";
    return "";
  }

  function numbersIn(text) {
    return (clean(text).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  }

  function fractionIn(text) {
    const match = clean(text).match(/(\d+(?:\.\d+)?)\s*(?:\/|of)\s*(\d+(?:\.\d+)?)/i);
    return match ? { attended: Number(match[1]), total: Number(match[2]) } : null;
  }

  function percentIn(text) {
    const value = clean(text);
    if (!value) return null;

    const match = value.match(/(\d+(?:\.\d+)?)\s*%/);
    if (match) return Number(match[1]);

    // A percentage column sometimes drops the sign.
    const bare = value.match(/^\d+(?:\.\d+)?$/);
    return bare ? Number(bare[0]) : null;
  }

  function readRow(cells, roles) {
    const cellFor = (role) => {
      const index = roles.indexOf(role);
      return index >= 0 && cells[index] ? clean(cells[index].textContent) : "";
    };

    const percentText = cellFor("pct");
    const attendedText = cellFor("attended");
    const totalText = cellFor("total");

    let attended = null;
    let total = null;
    let percent = percentIn(percentText);

    const percentFraction = fractionIn(percentText);
    if (percentFraction) {
      attended = percentFraction.attended;
      total = percentFraction.total;
    }

    const attendedFraction = fractionIn(attendedText);
    if (attendedFraction) {
      attended = attendedFraction.attended;
      total = attendedFraction.total;
    } else {
      const values = numbersIn(attendedText);
      if (values.length) attended = values[0];
    }

    // PESU labels the column "Total Classes" but writes "48/53" in the cell,
    // so a fraction here means attended/conducted, not just the total.
    const totalFraction = fractionIn(totalText);
    if (totalFraction) {
      total = totalFraction.total;
      if (attended == null) attended = totalFraction.attended;
    } else {
      const values = numbersIn(totalText);
      if (values.length) total = values[0];
    }

    // Fill in one missing side from the other two when possible.
    if (attended == null && total != null && percent != null) {
      attended = Math.round((percent / 100) * total);
    }
    if (total == null && attended != null && percent != null && percent > 0) {
      total = Math.round(attended / (percent / 100));
    }

    if (attended != null && total != null && total > 0 && attended >= 0 && attended <= total * 1.05) {
      const counted = { attended: Math.round(attended), total: Math.round(total) };
      counted.percent = (counted.attended / counted.total) * 100;
      return counted;
    }

    if (percent != null && percent >= 0 && percent <= 100) {
      return { attended: null, total: null, percent };
    }

    return null;
  }

  /* ───────────── the maths ───────────── */

  // p = attended / total
  //   at/above 75%: largest k with attended / (total + k) >= 0.75
  //   below 75%:   smallest m with (attended + m) / (total + m) >= 0.75
  function planFor(attended, total) {
    if (attended == null || total == null || !(total > 0)) return null;

    const current = attended / total;
    if (current >= TARGET - 1e-9) {
      return {
        percent: current * 100,
        skip: Math.max(0, Math.floor(attended / TARGET - total + 1e-9)),
        attend: 0,
      };
    }

    return {
      percent: current * 100,
      skip: 0,
      attend: Math.max(0, Math.ceil((TARGET * total - attended) / (1 - TARGET) - 1e-9)),
    };
  }

  /* ───────────── the column ───────────── */

  function setCell(cell, text, title, colour) {
    if (cell.dataset.planText !== text) {
      cell.textContent = text;
      cell.dataset.planText = text;
    }
    if (cell.title !== title) cell.title = title;
    if (cell.dataset.planColour !== colour) {
      cell.style.color = colour || "";
      cell.dataset.planColour = colour || "";
    }
  }

  function fillCell(cell, row) {
    cell.style.whiteSpace = "nowrap";
    cell.style.fontWeight = "600";
    cell.style.textAlign = "center";

    if (!row) {
      setCell(cell, "—", "Could not read attendance figures from this row.", "");
      return;
    }

    const plan = planFor(row.attended, row.total);

    if (!plan) {
      if (row.percent != null) {
        const safe = row.percent >= TARGET * 100;
        setCell(
          cell,
          safe ? "75%+" : "Below 75%",
          `Only a percentage is shown here (${row.percent.toFixed(1)}%). ` +
            "Add attended and conducted counts to see how many classes can be skipped.",
          safe ? "#0f7b3f" : "#b42318"
        );
      } else {
        setCell(cell, "—", "Could not read attendance figures from this row.", "");
      }
      return;
    }

    const counts = `${row.attended}/${row.total}, ${plan.percent.toFixed(1)}% now`;

    if (plan.skip > 0) {
      const label = plan.skip === 1 ? "class" : "classes";
      setCell(
        cell,
        `Skip ${plan.skip} ${label}`,
        `${counts}. You can skip up to ${plan.skip} more ${label} and stay at or above 75%.`,
        "#0f7b3f"
      );
    } else if (plan.attend > 0) {
      const label = plan.attend === 1 ? "class" : "classes";
      setCell(
        cell,
        `Attend ${plan.attend} ${label}`,
        `${counts}. Attend the next ${plan.attend} ${label} in a row to reach 75%.`,
        "#b42318"
      );
    } else {
      setCell(
        cell,
        "No room",
        `${counts}. You are exactly at 75%, so skipping any class drops you below it.`,
        "#b05a00"
      );
    }
  }

  function rolesOf(row) {
    return Array.from(row.cells).map((cell) =>
      cell.hasAttribute(PLAN_ATTR) ? "" : roleFor(cell.textContent)
    );
  }

  function headerScore(row) {
    const roles = rolesOf(row);
    let score = roles.filter(Boolean).length;
    if (roles.includes("attended") && roles.includes("total")) score += 3;
    if (roles.includes("pct")) score += 1;
    return score;
  }

  function findHeaderRow(rows) {
    let best = null;
    let bestScore = 0;

    for (const row of rows) {
      const score = headerScore(row);
      if (score > bestScore) {
        best = row;
        bestScore = score;
      }
    }

    return bestScore > 0 ? best : null;
  }

  function processTable(table) {
    const rows = Array.from(table.rows || []);
    if (rows.length < 2) return;

    const headerRow = findHeaderRow(rows);
    if (!headerRow) return;

    const headerCells = Array.from(headerRow.cells);
    const roles = headerCells.map((cell) =>
      cell.hasAttribute(PLAN_ATTR) ? "" : roleFor(cell.textContent)
    );

    const pctIndex = roles.indexOf("pct");
    const attendedIndex = roles.indexOf("attended");
    const totalIndex = roles.indexOf("total");

    if (pctIndex < 0 && attendedIndex < 0 && totalIndex < 0) return;

    // PESU's own attendance table has one "Total Classes" column whose cells
    // read "48/53". That single column supplies both numbers.
    const totalCarriesFraction =
      totalIndex >= 0 &&
      rows.some(
        (row) =>
          row !== headerRow &&
          row.cells[totalIndex] &&
          fractionIn(row.cells[totalIndex].textContent)
      );

    const hasAttended = attendedIndex >= 0 || totalCarriesFraction;
    if (pctIndex < 0 && !(hasAttended && totalIndex >= 0)) return;

    // The plan column sits immediately after the attendance details.
    const anchor = Math.max(pctIndex, attendedIndex, totalIndex);
    if (anchor < 0) return;

    let planHeader = headerCells.find((cell) => cell.hasAttribute(PLAN_ATTR));
    if (!planHeader) {
      planHeader = document.createElement("th");
      planHeader.setAttribute(PLAN_ATTR, "1");
      planHeader.textContent = "75% plan";
      planHeader.title =
        "How many classes you can skip, or must attend in a row, to stay at or above 75%.";
      planHeader.style.whiteSpace = "nowrap";

      const anchorCell = headerCells[anchor];
      if (anchorCell) planHeader.className = anchorCell.className;
      if (anchorCell && anchorCell.nextSibling) {
        headerRow.insertBefore(planHeader, anchorCell.nextSibling);
      } else {
        headerRow.appendChild(planHeader);
      }
    }

    for (const row of rows) {
      if (row === headerRow) continue;

      const cells = Array.from(row.cells);
      if (cells.length < 2) continue;

      let planCell = cells.find((cell) => cell.hasAttribute(PLAN_ATTR));
      if (!planCell) {
        planCell = document.createElement("td");
        planCell.setAttribute(PLAN_ATTR, "1");

        const anchorCell = cells[anchor];
        if (anchorCell) planCell.className = anchorCell.className;
        if (anchorCell && anchorCell.nextSibling) {
          row.insertBefore(planCell, anchorCell.nextSibling);
        } else {
          row.appendChild(planCell);
        }
      }

      fillCell(planCell, readRow(cells, roles));
    }
  }

  /* ───────────── keep up with the page ───────────── */

  let queued = 0;

  function scan() {
    queued = 0;
    for (const table of document.querySelectorAll("table")) {
      // Skip nested tables; the outer one gets its own pass.
      if (table.parentElement && table.parentElement.closest("table")) continue;
      try {
        processTable(table);
      } catch (error) {
        // A single odd table must not stop the rest of the page.
        console.warn("Attendance helper skipped a table", error);
      }
    }
  }

  function schedule() {
    if (queued) return;
    queued = setTimeout(scan, 350);
  }

  scan();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan, { once: true });
  }

  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Some portals fill the table after an AJAX round-trip without a mutation
  // we happen to catch first, so a slow sweep keeps things accurate.
  setInterval(scan, 2500);
})();
