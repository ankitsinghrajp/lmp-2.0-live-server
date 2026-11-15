
const accountId = "";
const apiToken = "";
const model =
  process.env.CLOUDFLARE_IMAGE_MODEL ||
  "@cf/black-forest-labs/flux-1-schnell";

const endpoint =
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  },
  
  body: JSON.stringify({
    prompt: "A parabola opening upwards, with vertex at (3, -1), and x-axis crossing point at (2, 0) and (4, 0).",
  }),
});
console.log("For: A parabola opening upwards, with vertex at (3, -1), and x-axis crossing point at (2, 0) and (4, 0).");
console.log("HTTP status:", response.status);
console.log("Content-Type:", response.headers.get("content-type"));

if (!response.ok) {
  console.log("Error:", await response.text());
} else {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const result = await response.json();
    console.log("Success:", result.success);
    console.log("Image returned:", Boolean(result.result?.image));
  } else {
    const image = Buffer.from(await response.arrayBuffer());
    console.log("Image bytes:", image.length);
  }
}
