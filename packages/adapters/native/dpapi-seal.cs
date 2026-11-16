using System;
using System.IO;
using System.Security.Cryptography;

internal static class Program
{
    private static int Main(string[] args)
    {
        if (args.Length != 2)
        {
            Console.Error.WriteLine("Usage: dpapi-seal <protect|unprotect> <entropy-b64>");
            return 2;
        }

        string mode = args[0];
        byte[] entropy = Convert.FromBase64String(args[1]);
        string stdinB64 = Console.In.ReadToEnd().Trim();
        if (stdinB64.Length == 0)
        {
            Console.Error.WriteLine("Missing stdin payload");
            return 2;
        }

        byte[] input = Convert.FromBase64String(stdinB64);

        if (mode == "protect")
        {
            byte[] output = ProtectedData.Protect(input, entropy, DataProtectionScope.CurrentUser);
            Console.Write(Convert.ToBase64String(output));
            return 0;
        }

        if (mode == "unprotect")
        {
            byte[] output = ProtectedData.Unprotect(input, entropy, DataProtectionScope.CurrentUser);
            Console.Write(Convert.ToBase64String(output));
            return 0;
        }

        Console.Error.WriteLine("Unknown mode");
        return 2;
    }
}
