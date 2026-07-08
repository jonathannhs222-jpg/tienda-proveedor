// server.js
// Backend mínimo: crea el cobro (Stripe o PayPal) y, cuando se confirma,
// envía automáticamente el email de "gracias + contacto del proveedor" por Gmail.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const nodemailer = require("nodemailer");
const paypal = require("@paypal/checkout-server-sdk");

const app = express();

// Stripe necesita el body "raw" SOLO en la ruta del webhook,
// por eso esa ruta se declara antes de app.use(express.json())
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.post(
  "/webhook-stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Firma de webhook inválida:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const emailCliente = session.customer_details?.email;
      if (emailCliente) {
        await enviarEmailGracias(emailCliente);
      }
    }

    res.json({ received: true });
  }
);

app.use(cors());
app.use(express.json());

// ---------- CONFIGURACIÓN DEL PRODUCTO ----------
const PRODUCTO = {
  nombre: "Textil Andina — Acceso Mayorista",
  descripcion: "Catálogo, tarifas y contacto directo del proveedor",
  precioCentimos: 14900, // 149,00 €
  moneda: "eur",
};

// ---------- STRIPE: crear sesión de pago ----------
app.post("/crear-sesion-stripe", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: PRODUCTO.moneda,
            product_data: {
              name: PRODUCTO.nombre,
              description: PRODUCTO.descripcion,
            },
            unit_amount: PRODUCTO.precioCentimos,
          },
          quantity: 1,
        },
      ],
      success_url: `${process.env.FRONTEND_URL}/gracias.html`,
      cancel_url: `${process.env.FRONTEND_URL}/proveedor.html`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo crear la sesión de pago" });
  }
});

// ---------- PAYPAL: cliente ----------
function clientePaypal() {
  const environment =
    process.env.PAYPAL_ENV === "live"
      ? new paypal.core.LiveEnvironment(
          process.env.PAYPAL_CLIENT_ID,
          process.env.PAYPAL_CLIENT_SECRET
        )
      : new paypal.core.SandboxEnvironment(
          process.env.PAYPAL_CLIENT_ID,
          process.env.PAYPAL_CLIENT_SECRET
        );
  return new paypal.core.PayPalHttpClient(environment);
}

// ---------- PAYPAL: crear orden ----------
app.post("/crear-orden-paypal", async (req, res) => {
  const request = new paypal.orders.OrdersCreateRequest();
  request.prefer("return=representation");
  request.requestBody({
    intent: "CAPTURE",
    purchase_units: [
      {
        amount: {
          currency_code: "EUR",
          value: (PRODUCTO.precioCentimos / 100).toFixed(2),
        },
        description: PRODUCTO.nombre,
      },
    ],
  });
  try {
    const order = await clientePaypal().execute(request);
    res.json({ id: order.result.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo crear la orden de PayPal" });
  }
});

// ---------- PAYPAL: capturar orden (aquí se confirma el cobro) ----------
app.post("/capturar-orden-paypal/:orderID", async (req, res) => {
  const request = new paypal.orders.OrdersCaptureRequest(
    req.params.orderID
  );
  request.requestBody({});
  try {
    const capture = await clientePaypal().execute(request);
    const status = capture.result.status;
    const emailCliente = capture.result.payer?.email_address;

    if (status === "COMPLETED" && emailCliente) {
      await enviarEmailGracias(emailCliente);
    }
    res.json({ status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo capturar el pago de PayPal" });
  }
});

// ---------- EMAIL AUTOMÁTICO (Gmail) ----------
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,        // tu-correo@gmail.com
    pass: process.env.GMAIL_APP_PASSWORD, // contraseña de aplicación (no tu contraseña normal)
  },
});

async function enviarEmailGracias(destinatario) {
  const html = `
    <div style="font-family:Arial,sans-serif; max-width:520px; margin:auto; color:#222;">
      <h2 style="color:#c07a1f;">¡Gracias por tu compra!</h2>
      <p>Ya tienes acceso a <b>${PRODUCTO.nombre}</b>. Aquí tienes el contacto
      directo del proveedor para que empieces a pedir cuando quieras:</p>

      <div style="background:#f6f2ea; border-radius:10px; padding:18px; margin:20px 0;">
        <p style="margin:0 0 6px;"><b>Persona de contacto:</b> [NOMBRE DEL CONTACTO]</p>
        <p style="margin:0 0 6px;"><b>Email:</b> [EMAIL DEL PROVEEDOR]</p>
        <p style="margin:0;"><b>WhatsApp:</b> [TELÉFONO DEL PROVEEDOR]</p>
      </div>

      <p>Si tienes cualquier duda con el pedido o el proveedor no responde,
      escríbeme directamente respondiendo a este correo.</p>

      <p style="margin-top:28px;">Un saludo,<br>[TU NOMBRE]</p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Textil Andina" <${process.env.GMAIL_USER}>`,
    to: destinatario,
    subject: "Tu acceso al proveedor — gracias por tu compra",
    html,
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en el puerto ${PORT}`));
