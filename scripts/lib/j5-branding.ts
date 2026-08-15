/**
 * Fork-owned product identity.
 *
 * Keep upstream's T3CODE_* environment and protocol-internal names intact. This
 * module only owns values that identify J5 Code to people, operating systems,
 * installers, and deep-link dispatchers.
 */
export const J5_BRANDING = {
  desktop: {
    baseName: "J5 Code",
    developmentName: "J5 Code (Dev)",
    nightlyName: "J5 Code (Nightly)",
    appId: "codes.jackson.j5code",
    developmentAppId: "codes.jackson.j5code.dev",
    productionScheme: "j5code",
    developmentScheme: "j5code-dev",
    linuxExecutableName: "j5code",
    defaultBaseDirName: ".j5code",
    productionUserDataDirName: "j5code",
    developmentUserDataDirName: "j5code-dev",
  },
  mobile: {
    slug: "j5-code",
    development: {
      appName: "J5 Code Dev",
      scheme: "j5code-dev",
      appId: "codes.jackson.j5code.dev",
    },
    preview: {
      appName: "J5 Code Preview",
      scheme: "j5code-preview",
      appId: "codes.jackson.j5code.preview",
    },
    production: {
      appName: "J5 Code",
      scheme: "j5code",
      appId: "codes.jackson.j5code",
    },
  },
} as const;
