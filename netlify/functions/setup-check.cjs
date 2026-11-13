
const admin = require("firebase-admin");

exports.handler = async function () {
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

    // Test an actual connection to Firestore.
    const db = admin.firestore();
    const collections = await db.listCollections();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        success: true,
        firebaseConnected: true,
        firestoreConnected: true,
        firebaseProject: serviceAccount.project_id,
        collectionCount: collections.length,
        paystackSecretConfigured:
          Boolean(process.env.PAYSTACK_SECRET_KEY),
        message: "Firebase and Firestore are connected.",
      }),
    };

  } catch (error) {
    console.error("Backend connection test failed:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        message: "Backend connection test failed.",
      }),
    };
  }
};
