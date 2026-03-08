const input = document.getElementById("domainInput");
const button = document.getElementById("checkBtn");
const result = document.getElementById("result");

button.addEventListener("click", checkDomain);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") checkDomain();
});

async function checkDomain() {
  const domain = input.value.trim();

  if (!domain) {
    showError("Please enter a domain first.");
    return;
  }

  result.classList.remove("hidden");
  result.innerHTML = "<p>Checking domain...</p>";

  try {
    const response = await fetch("/api/check", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ domain }),
    });

    const data = await response.json();

    if (!response.ok) {
      showError(data.error || "Something went wrong.");
      return;
    }

    renderResult(data);
  } catch (error) {
    showError("Network error. Please try again.");
  }
}

function renderResult(data) {
  const riskClass = data.riskLevel.toLowerCase();

  result.innerHTML = `
    <div class="badge ${riskClass}">${data.riskLevel} RISK</div>
    <h2>${data.domain}</h2>
    <p><strong>Created:</strong> ${data.createdAt}</p>
    <p><strong>Age (days):</strong> ${data.ageDays ?? "Unknown"}</p>
    <p><strong>Owner hidden:</strong> ${data.hiddenOwner ? "Yes" : "No"}</p>
    <p><strong>Risky extension:</strong> ${data.riskyTld}</p>
    <p><strong>Risk score:</strong> ${data.score}/100</p>

    <h3>Reasons</h3>
    <ul>
      ${data.reasons.map((reason) => `<li>${reason}</li>`).join("")}
    </ul>
  `;
}

function showError(message) {
  result.classList.remove("hidden");
  result.innerHTML = `<p>${message}</p>`;
}