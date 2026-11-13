
const admin = require("firebase-admin");

module.exports.handler = async function (event, context) {
  try {
    const encodedCredentials =
      process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

    if (!encodedCredentials) {
      throw new Error("Firebase credentials are missing.");
    }

    const credentialsJSON = Buffer.from(
      encodedCredentials,
      "base64"
    ).toString("utf8");

    const serviceAccount = JSON.parse(credentialsJSON);

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }

    const paystackConfigured =
      Boolean(process.env.PAYSTACK_SECRET_KEY);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        success: true,
        firebaseConnected: true,
        firebaseProject: admin.app().options.projectId,
        paystackSecretConfigured: paystackConfigured,
        message: "Backend configuration check successful.",
      }),
    };
  } catch (error) {
    console.error("Setup check failed:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        message: "Backend configuration check failed.",
      }),
    };
  }
};
