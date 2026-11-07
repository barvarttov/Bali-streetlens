// The provincial CCTV camera that watches each junction of the airport corridor (config/cameras.json).
// Checked by position: each camera is within 25 m of its junction, except Pintu Tol (116 m, same name).
// Until a junction's own camera is calibrated, its label and arms stay synthetic; only the AGA count is real.
export const JUNCTION_CAMERA: Readonly<Record<string, string>> = {
  "patung-kuda": "simpang-patung-kuda",
  "underpass-ngurah-rai": "underpass-ngurah-rai-utara",
  kedonganan: "simpang-kedonganan",
  unud: "simpang-unud",
  "taman-griya": "simpang-taman-griya",
  "pintu-tol": "simpang-pintu-tol",
};
