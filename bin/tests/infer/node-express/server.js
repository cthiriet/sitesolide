// A fixture of bin/tests/cli-infer.test.ts: an Express server that calls out
// and reads a secret. Never run.
const express = require("express");
const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

app.get("/rates", async (_request, response) => {
  const rates = await fetch("https://api.example.com/rates");
  response.json({ rates: await rates.json(), mode: process.env.CHECKOUT_MODE });
});

app.post("/charge", async (_request, response) => {
  response.json(await stripe.paymentIntents.create({ amount: 100, currency: "eur" }));
});

app.listen(process.env.PORT);
