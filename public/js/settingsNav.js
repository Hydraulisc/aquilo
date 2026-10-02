// Save themes?
const themeSelect = document.getElementById("theme-select");
const customApply = document.getElementById("apply-custom");

const customVariableNames = [
    "bg-color",
    "bg-secondary",
    "text-color",
    "text-secondary",
    "accent-color",
    "accent-secondary",
    "accent-terciary",
    "nav-bg",
    "button-bg",
    "button-text"
];

// load preference
const savedTheme = localStorage.getItem("theme") || "dark";
document.documentElement.setAttribute("data-theme", savedTheme);
themeSelect.value = savedTheme;
console.log(savedTheme);

themeSelect.addEventListener("change", (e) => {
    document.documentElement.setAttribute("data-theme", e.target.value);
    localStorage.setItem("theme", e.target.value);
    if(e.target.value !== "custom") clearCustomTheme();
});

// clear custom theme in renderer
function clearCustomTheme() {
    customVariableNames.forEach((name) => {
        document.documentElement.style.removeProperty(`--${name}`);
    });
}

// custom themes
customApply.addEventListener("click", () => {
    const vars = {
        "bg-color": document.getElementById("bg-color").value,
        "bg-secondary": document.getElementById("bg-secondary").value,
        "text-color": document.getElementById("text-color").value,
        "text-secondary": document.getElementById("text-secondary").value,
        "accent-color": document.getElementById("accent-color").value,
        "accent-secondary": document.getElementById("accent-secondary").value,
        "accent-terciary": document.getElementById("accent-terciary").value,
        "nav-bg": document.getElementById("nav-bg").value,
        "button-bg": document.getElementById("button-bg").value,
        "button-text": document.getElementById("button-text").value,
    };

    // Apply to document
    for (let key in vars) {
        document.documentElement.style.setProperty(`--${key}`, vars[key]);
    }

    // mark it as "custom"
    localStorage.setItem("theme", "custom");
    localStorage.setItem("customTheme", JSON.stringify(vars));
});

// prettify section switching
document.querySelectorAll(".settings_nav .navlink").forEach(link => {
    link.addEventListener("click", (e) => {
        document.querySelectorAll(".settings_nav .navlink").forEach(l => l.classList.remove("active"));
        link.classList.add("active");
    });
});

// basic custom theme loader (beta?)
if (savedTheme === "custom") {
    const customTheme = JSON.parse(localStorage.getItem("customTheme"));
    if (customTheme) {
        for (let key in customTheme) {
            document.documentElement.style.setProperty(`--${key}`, customTheme[key]);
            const input = document.getElementById(key);
            if (input) input.value = customTheme[key];
        }
    }
}

// ---- Theme Import / Export (client-side only) ----

// EXPORT: Convert saved customTheme to JSON and trigger download
function exportTheme() {
    const theme = JSON.parse(localStorage.getItem("customTheme"));
    if (!theme) return alert("No custom theme saved to export.");

    const blob = new Blob([JSON.stringify(theme, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "aquilo-theme.json";
    a.click();
    URL.revokeObjectURL(url);
}

// IMPORT: Load theme JSON and apply it
function importTheme(file) {
    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const imported = JSON.parse(event.target.result);
            if (!imported || typeof imported !== "object") throw new Error();

            // Apply new variables
            Object.entries(imported).forEach(([key, value]) => {
                document.documentElement.style.setProperty(`--${key}`, value);
                const input = document.getElementById(key);
                if (input) input.value = value;
            });

            // Persist it
            localStorage.setItem("customTheme", JSON.stringify(imported));
            localStorage.setItem("theme", "custom");

            alert("Theme imported successfully!");
        } catch {
            alert("Invalid theme file. Please select a valid Aquilo theme JSON.");
        }
    };
    reader.readAsText(file);
}
