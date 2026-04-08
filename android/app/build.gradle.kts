plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.remotedisplay.player"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.remotedisplay.player"
        minSdk = 26
        targetSdk = 34
        versionCode = 10
        versionName = "1.7.7"
    }

    signingConfigs {
        create("release") {
            storeFile = file("../release-key.jks")
            storePassword = System.getenv("KEYSTORE_PASSWORD") ?: findProperty("KEYSTORE_PASSWORD") as String? ?: ""
            keyAlias = System.getenv("KEY_ALIAS") ?: findProperty("KEY_ALIAS") as String? ?: "remotedisplay"
            keyPassword = System.getenv("KEY_PASSWORD") ?: findProperty("KEY_PASSWORD") as String? ?: ""
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("release")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // AndroidX
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("androidx.lifecycle:lifecycle-service:2.7.0")

    // Encrypted SharedPreferences
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // ExoPlayer / Media3
    implementation("androidx.media3:media3-exoplayer:1.2.1")
    implementation("androidx.media3:media3-ui:1.2.1")

    // Socket.IO client
    implementation("io.socket:socket.io-client:2.1.0")

    // WorkManager for background downloads
    implementation("androidx.work:work-runtime-ktx:2.9.0")

    // Gson for JSON
    implementation("com.google.code.gson:gson:2.10.1")

    // OkHttp for file downloads
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
}
