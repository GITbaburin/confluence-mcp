// api/health.ts
export default function handler(_req: any, res: any) {
    // Works with Vercel’s serverless response object
    if (typeof res.status === "function" && typeof res.send === "function") {
      res.status(200).send("ok");
      return;
    }
    // Fallback for plain Node http
    res.statusCode = 200;
    res.setHeader?.("Content-Type", "text/plain");
    res.end?.("ok");
  }