const button = document.getElementById("save");

async function onSave() {
  const note = await window.notes.save("hello");
  render(note);
}

function render(note) {
  button.textContent = note.text;
}

button.addEventListener("click", onSave);
window.notes.onCleared(() => render({ text: "" }));
