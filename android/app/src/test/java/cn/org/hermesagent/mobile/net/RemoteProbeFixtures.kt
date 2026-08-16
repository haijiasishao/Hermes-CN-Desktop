package cn.org.hermesagent.mobile.net

/** Real dashboard-shaped JSON responses used by [RemoteProbeClientTest]. */
internal object RemoteProbeFixtures {
    const val PUBLIC_STATUS = """
        {"auth_required":false,"version":"0.7.0"}
    """

    const val GATED_STATUS = """
        {"auth_required":true,"version":"0.7.0-gated"}
    """

    const val MIXED_PROVIDERS = """
        {
          "providers": [
            {"name":"password","display_name":"Password","supports_password":true},
            {"name":"oauth","display_name":"OAuth","supports_password":false},
            {"name":"fallback-name"},
            {"name":"null-display","display_name":null,"supports_password":"true"},
            null,
            "not-an-object",
            {"display_name":"missing-name","supports_password":true},
            {"name":42,"display_name":"wrong-name-type"},
            {"name":"   ","display_name":"blank-name"},
            {"name":"invalid-supports","supports_password":[]}
          ]
        }
    """

    const val EMPTY_PROVIDERS = """
        {"providers":[]}
    """
}
