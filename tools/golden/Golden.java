import java.util.Random;

// Headless harness: dumps the board the original applet would generate for a
// given size (34 or 56) and java.util.Random seed. Used as the golden reference
// for the JavaScript port (tests/golden.test.js).
public class Golden {
    public static void main(String[] a) {
        int meret = Integer.parseInt(a[0]);
        long seed = Long.parseLong(a[1]);
        Board b = new Board(null, 0, 0);
        b.meret = meret;
        b.create();
        b.R = new Random(seed);
        b.init();
        StringBuilder sb = new StringBuilder();
        sb.append("{\"size\":").append(meret).append(",\"tiles\":[");
        Tile t = b.firstAllTile; boolean first = true;
        while (t != null) {
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"type\":\"").append(t.type).append("\",\"resource\":\"").append(t.resource)
              .append("\",\"number\":").append(t.pontertek).append(",\"robber\":").append(t.hasRablo)
              .append(",\"juncs\":[");
            for (int i = 0; i < t.nJuncs; i++) { if (i > 0) sb.append(','); sb.append(t.juncs[i].no); }
            sb.append("]}");
            t = t.nextAllTile;
        }
        sb.append("],\"junctions\":[");
        Junction j = b.firstJunc; first = true;
        while (j != null) {
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"no\":").append(j.no).append(",\"harbor\":\"").append(j.resource).append("\",\"juncs\":[");
            for (int i = 0; i < j.nJuncs; i++) { if (i > 0) sb.append(','); sb.append(j.juncs[i].no); }
            sb.append("]}");
            j = j.nextJunc;
        }
        sb.append("]}");
        System.out.println(sb);
    }
}
