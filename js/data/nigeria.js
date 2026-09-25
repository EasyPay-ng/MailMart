// Nigerian administrative divisions and bank list.
//
// Shared by the address forms (state -> LGA -> street) and the withdrawal
// payout form. Kept as static data: these change far more slowly than the app
// does, and it keeps both forms working without a network call.
//
// Source: nigeria-lga-data@1.0.0   - 774 LGAs across 36 states + FCT
//         nigeria-banks-list@1.1.8 - commercial, digital and microfinance
//                                    banks with NIP codes

export const NIGERIA = [
  { state:"Abia", zone:"South East", lgas:[
    "Aba North","Aba South","Arochukwu","Bende","Ikwuano","Isiala-Ngwa North",
    "Isiala-Ngwa South","Isuikwato","Obi Nwa","Ohafia","Osisioma","Ugwunagbo","Ukwa East",
    "Ukwa West","Umu-Neochi","Umuahia North","Umuahia South"
  ] },
  { state:"Adamawa", zone:"North East", lgas:[
    "Demsa","Fufore","Ganye","Girei","Gombi","Guyuk","Hong","Jada","Lamurde","Madagali","Maiha",
    "Mayo-Belwa","Michika","Mubi North","Mubi South","Numan","Shelleng","Song","Toungo",
    "Yola North","Yola South"
  ] },
  { state:"Akwa Ibom", zone:"South South", lgas:[
    "Abak","Eastern Obolo","Eket","Esit Eket","Essien Udim","Etim Ekpo","Etinan","Ibeno",
    "Ibesikpo Asutan","Ibiono-Ibom","Ika","Ikono","Ikot Abasi","Ikot Ekpene","Ini","Itu","Mbo",
    "Mkpat-Enin","Nsit-Atai","Nsit-Ibom","Nsit-Ubium","Obot Akara","Okobo","Onna","Oron",
    "Oruk Anam","Udung-Uko","Ukanafun","Uruan","Urue-Offong/Oruko","Uyo"
  ] },
  { state:"Anambra", zone:"South East", lgas:[
    "Aguata","Anambra East","Anambra West","Anaocha","Awka North","Awka South","Ayamelum",
    "Dunukofia","Ekwusigo","Idemili North","Idemili south","Ihiala","Njikoka","Nnewi North",
    "Nnewi South","Ogbaru","Onitsha North","Onitsha South","Orumba North","Orumba South","Oyi"
  ] },
  { state:"Bauchi", zone:"North East", lgas:[
    "Alkaleri","Bauchi","Bogoro","Damban","Darazo","Dass","Gamawa","Ganjuwa","Giade",
    "Itas/Gadau","Jama'are","Katagum","Kirfi","Misau","Ningi","Shira","Tafawa Balewa","Toro",
    "Warji","Zaki"
  ] },
  { state:"Bayelsa", zone:"South South", lgas:[
    "Brass","Ekeremor","Kolokuma/Opokuma","Nembe","Ogbia","Sagbama","Southern Ijaw","Yenagoa"
  ] },
  { state:"Benue", zone:"North Central", lgas:[
    "Ado","Agatu","Apa","Buruku","Gboko","Guma","Gwer East","Gwer West","Katsina-Ala",
    "Konshisha","Kwande","Logo","Makurdi","Obi","Ogbadibo","Ohimini","Oju","Okpokwu","Otukpo",
    "Tarka","Ukum","Ushongo","Vandeikya"
  ] },
  { state:"Borno", zone:"North East", lgas:[
    "Abadam","Askira/Uba","Bama","Bayo","Biu","Chibok","Damboa","Dikwa","Gubio","Guzamala",
    "Gwoza","Hawul","Jere","Kaga","Kala/Balge","Konduga","Kukawa","Kwaya Kusar","Mafa",
    "Magumeri","Maiduguri","Marte","Mobbar","Monguno","Ngala","Nganzai","Shani"
  ] },
  { state:"Cross River", zone:"South South", lgas:[
    "Abi","Akamkpa","Akpabuyo","Bakassi","Bekwarra","Biase","Boki","Calabar Municipal",
    "Calabar South","Etung","Ikom","Obanliku","Obubra","Obudu","Odukpani","Ogoja","Yakuur",
    "Yala"
  ] },
  { state:"Delta", zone:"South South", lgas:[
    "Aniocha North","Aniocha South","Bomadi","Burutu","Ethiope East","Ethiope West",
    "Ika North East","Ika South","Isoko North","Isoko South","Ndokwa East","Ndokwa West","Okpe",
    "Oshimili North","Oshimili South","Patani","Sapele","Udu","Ughelli North","Ughelli South",
    "Ukwuani","Uvwie","Warri North","Warri South","Warri South West"
  ] },
  { state:"Ebonyi", zone:"South East", lgas:[
    "Abakaliki","Afikpo North","Afikpo South","Ebonyi","Ezza North","Ezza South","Ikwo",
    "Ishielu","Ivo","Izzi","Ohaozara","Ohaukwu","Onicha"
  ] },
  { state:"Edo", zone:"South South", lgas:[
    "Akoko-Edo","Egor","Esan Central","Esan North-East","Esan South-East","Esan West",
    "Etsako Central","Etsako East","Etsako West","Igueben","Ikpoba Okha","Oredo","Orhionmwon",
    "Ovia North-East","Ovia South-West","Owan East","Owan West","Uhunmwonde"
  ] },
  { state:"Ekiti", zone:"South West", lgas:[
    "Ado-Ekiti","Efon","Ekiti East","Ekiti South-West","Ekiti West","Emure","Gbonyin","Ido-Osi",
    "Ijero","Ikere","Ikole","Ilejemeje","Irepodun/Ifelodun","Ise/Orun","Moba","Oye"
  ] },
  { state:"Enugu", zone:"South East", lgas:[
    "Aninri","Awgu","Enugu East","Enugu North","Enugu South","Ezeagu","Igbo Etiti",
    "Igbo Eze North","Igbo Eze South","Isi Uzo","Nkanu East","Nkanu West","Nsukka","Oji River",
    "Udenu","Udi","Uzo-Uwani"
  ] },
  { state:"Federal Capital Territory", zone:"North Central", lgas:[
    "Abaji","Bwari","Gwagwalada","Kuje","Kwali","Municipal Area Council"
  ] },
  { state:"Gombe", zone:"North East", lgas:[
    "Akko","Balanga","Billiri","Dukku","Funakaye","Gombe","Kaltungo","Kwami","Nafada","Shongom",
    "Yamaltu/Deba"
  ] },
  { state:"Imo", zone:"South East", lgas:[
    "Aboh Mbaise","Ahiazu Mbaise","Ehime Mbano","Ezinihitte","Ideato North","Ideato South",
    "Ihitte/Uboma","Ikeduru","Isiala Mbano","Isu","Mbaitoli","Ngor Okpala","Njaba","Nkwerre",
    "Nwangele","Obowo","Oguta","Ohaji/Egbema","Okigwe","Orlu","Orsu","Oru East","Oru West",
    "Owerri Municipal","Owerri North","Owerri West","Unuimo"
  ] },
  { state:"Jigawa", zone:"North West", lgas:[
    "Auyo","Babura","Biriniwa","Birni Kudu","Buji","Dutse","Gagarawa","Garki","Gumel","Guri",
    "Gwaram","Gwiwa","Hadejia","Jahun","Kafin Hausa","Kaugama","Kazaure","Kiri Kasamma","Kiyawa",
    "Maigatari","Malam Madori","Miga","Ringim","Roni","Sule-Tankarkar","Taura","Yankwashi"
  ] },
  { state:"Kaduna", zone:"North West", lgas:[
    "Birnin Gwari","Chikun","Giwa","Igabi","Ikara","Jaba","Jema'a","Kachia","Kaduna North",
    "Kaduna South","Kagarko","Kajuru","Kaura","Kauru","Kubau","Kudan","Lere","Makarfi",
    "Sabon Gari","Sanga","Soba","Zangon Kataf","Zaria"
  ] },
  { state:"Kano", zone:"North West", lgas:[
    "Ajingi","Albasu","Bagwai","Bebeji","Bichi","Bunkure","Dala","Dambatta","Dawakin Kudu",
    "Dawakin Tofa","Doguwa","Fagge","Gabasawa","Garko","Garum Mallam","Gaya","Gezawa","Gwale",
    "Gwarzo","Kabo","Kano Municipal","Karaye","Kibiya","Kiru","Kunchi","Kura","Madobi","Makoda",
    "Minjibir","Nasarawa","Rano","Rimin Gado","Rogo","Shanono","Sumaila","Takai","Tarauni",
    "Tofa","Tsanyawa","Tudun Wada","Ungogo","Warawa","Wudil","kumbotso"
  ] },
  { state:"Katsina", zone:"North West", lgas:[
    "Bakori","Batagarawa","Batsari","Baure","Bindawa","Charanchi","Dan Musa","Dandume","Danja",
    "Daura","Dutsi","Dutsin-Ma","Faskari","Funtua","Ingawa","Jibia","Kafur","Kaita","Kankara",
    "Kankia","Katsina","Kurfi","Kusada","Mai'Adua","Malumfashi","Mani","Mashi","Matazuu",
    "Musawa","Rimi","Sabuwa","Safana","Sandamu","Zango"
  ] },
  { state:"Kebbi", zone:"North West", lgas:[
    "Aleiro","Arewa Dandi","Argungu","Augie","Bagudo","Birnin Kebbi","Bunza","Dandi","Fakai",
    "Gwandu","Jega","Kalgo","Koko/Besse","Maiyama","Ngaski","Sakaba","Shanga","Suru",
    "Wasagu/Danko","Yauri","Zuru"
  ] },
  { state:"Kogi", zone:"North Central", lgas:[
    "Adavi","Ajaokuta","Ankpa","Bassa","Dekina","Ibaji","Idah","Igalamela Odolu","Ijumu",
    "Kabba/Bunu","Kogi","Lokoja","Mopa Muro","Ofu","Ogori/Magongo","Okehi","Okene","Olamaboro",
    "Omala","Yagba East","Yagba West"
  ] },
  { state:"Kwara", zone:"North Central", lgas:[
    "Asa","Baruten","Edu","Ekiti","Ifelodun","Ilorin East","Ilorin South","Ilorin West",
    "Irepodun","Isin","Kaiama","Moro","Offa","Oke Ero","Oyun","Pategi"
  ] },
  { state:"Lagos", zone:"South West", lgas:[
    "Agege","Ajeromi-Ifelodun","Alimosho","Amuwo-Odofin","Apapa","Badagry","Epe","Eti-Osa",
    "Ibeju/Lekki","Ifako-Ijaye","Ikeja","Ikorodu","Kosofe","Lagos Island","Lagos Mainland",
    "Mushin","Ojo","Oshodi-Isolo","Shomolu","Surulere"
  ] },
  { state:"Nasarawa", zone:"North Central", lgas:[
    "Akwanga","Awe","Doma","Karu","Keana","Keffi","Kokona","Lafia","Nasarawa","Nasarawa Egon",
    "Obi","Toto","Wamba"
  ] },
  { state:"Niger", zone:"North Central", lgas:[
    "Agaie","Agwara","Bida","Borgu","Bosso","Chanchaga","Edati","Gbako","Gurara","Katcha",
    "Kontagora","Lapai","Lavun","Magama","Mariga","Mashegu","Mokwa","Munya","Paikoro","Rafi",
    "Rijau","Shiroro","Suleja","Tafa","Wushishi"
  ] },
  { state:"Ogun", zone:"South West", lgas:[
    "Abeokuta North","Abeokuta South","Ado-Odo/Ota","Egbado North","Egbado South","Ewekoro",
    "Ifo","Ijebu East","Ijebu North","Ijebu North East","Ijebu Ode","Ikenne","Imeko Afon",
    "Ipokia","Obafemi Owode","Odeda","Odogbolu","Ogun Waterside","Remo North","Shagamu"
  ] },
  { state:"Ondo", zone:"South West", lgas:[
    "Akoko North East","Akoko North West","Akoko South Akure East","Akoko South West",
    "Akure North","Akure South","Ese-Odo","Idanre","Ifedore","Ilaje","Ile-Oluji/Okeigbo","Irele",
    "Odigbo","Okitipupa","Ondo East","Ondo West","Ose","Owo"
  ] },
  { state:"Osun", zone:"South West", lgas:[
    "Aiyedade","Aiyedire","Atakunmosa East","Atakunmosa West","Boluwaduro","Boripe","Ede North",
    "Ede South","Egbedore","Ejigbo","Ife Central","Ife East","Ife North","Ife South","Ifedayo",
    "Ifelodun","Ila","Ilesa East","Ilesa West","Irepodun","Irewole","Isokan","Iwo","Obokun",
    "Odo Otin","Ola Oluwa","Olorunda","Oriade","Orolu","Osogbo"
  ] },
  { state:"Oyo", zone:"South West", lgas:[
    "Afijio","Akinyele","Atiba","Atisbo","Egbeda","Ibadan North","Ibadan North-East",
    "Ibadan North-West","Ibadan South-East","Ibadan South-West","Ibarapa Central","Ibarapa East",
    "Ibarapa North","Ido","Irepo","Iseyin","Itesiwaju","Iwajowa","Kajola","Lagelu",
    "Ogbomosho North","Ogbomosho South","Ogo Oluwa","Olorunsogo","Oluyole","Ona Ara","Orelope",
    "Ori Ire","Oyo East","Oyo West","Saki East","Saki West","Surulere"
  ] },
  { state:"Plateau", zone:"North Central", lgas:[
    "Barkin Ladi","Bassa","Bokkos","Jos East","Jos North","Jos South","Kanam","Kanke",
    "Langtang North","Langtang South","Mangu","Mikang","Pankshin","Qua'an Pan","Riyom","Shendam",
    "Wase"
  ] },
  { state:"Rivers", zone:"South South", lgas:[
    "Abua/Odual","Ahoada East","Ahoada West","Akuku-Toru","Andoni","Asari-Toru","Bonny","Degema",
    "Eleme","Emuoha","Etche","Gokana","Ikwerre","Khana","Obio/Akpor","Ogba/Egbema/Ndoni",
    "Ogu/Bolo","Okrika","Omuma","Opobo/Nkoro","Oyigbo","Port Harcourt","Tai"
  ] },
  { state:"Sokoto", zone:"North West", lgas:[
    "Binji","Bodinga","Dange Shuni","Gada","Goronyo","Gudu","Gwadabawa","Illela","Isa","Kebbe",
    "Kware","Rabah","Sabon Birni","Shagari","Silame","Sokoto North","Sokoto South","Tambuwal",
    "Tangaza","Tureta","Wamako","Wurno","Yabo"
  ] },
  { state:"Taraba", zone:"North East", lgas:[
    "Ardo Kola","Bali","Donga","Gashaka","Gassol","Ibi","Jalingo","Karim Lamido","Kumi","Lau",
    "Sardauna","Takum","Ussa","Wukari","Yorro","Zing"
  ] },
  { state:"Yobe", zone:"North East", lgas:[
    "Bade","Bursari","Damaturu","Fika","Fune","Geidam","Gujba","Gulani","Jakusko","Karasuwa",
    "Karawa","Machina","Nangere","Nguru Potiskum","Tarmua","Yunusari","Yusufari"
  ] },
  { state:"Zamfara", zone:"North West", lgas:[
    "Anka","Bakura","Birnin Magaji","Bukkuyum","Bungudu","Gummi","Gusau","Kaura Namoda",
    "Maradun","Maru","Shinkafi","Talata Mafara","Tsafe","Zurmi"
  ] }
];

export const BANKS = [
  { name:"Access Bank", code:"044" },
  { name:"Citibank", code:"023" },
  { name:"Ecobank Nigeria", code:"050" },
  { name:"Fidelity Bank", code:"070" },
  { name:"First Bank of Nigeria", code:"011" },
  { name:"First City Monument Bank (FCMB)", code:"214" },
  { name:"Globus Bank", code:"00103" },
  { name:"Guaranty Trust Bank (GTB)", code:"058" },
  { name:"Heritage Bank", code:"030" },
  { name:"Keystone Bank", code:"082" },
  { name:"Parallex Bank", code:"526" },
  { name:"Polaris Bank", code:"076" },
  { name:"Providus Bank", code:"101" },
  { name:"Stanbic IBTC Bank", code:"221" },
  { name:"Standard Chartered Bank", code:"068" },
  { name:"Sterling Bank", code:"232" },
  { name:"SunTrust Bank", code:"100" },
  { name:"Union Bank of Nigeria", code:"032" },
  { name:"United Bank for Africa (UBA)", code:"033" },
  { name:"Unity Bank", code:"215" },
  { name:"Wema Bank", code:"035" },
  { name:"Zenith Bank", code:"057" },
  { name:"AB Microfinance Bank", code:"801" },
  { name:"Accion Microfinance Bank", code:"802" },
  { name:"Addosser Microfinance Bank", code:"803" },
  { name:"Baobab Microfinance Bank", code:"804" },
  { name:"Fina Trust Microfinance Bank", code:"805" },
  { name:"Infinity Microfinance Bank", code:"806" },
  { name:"Lapo Microfinance Bank", code:"807" },
  { name:"Mainstreet Microfinance Bank", code:"808" },
  { name:"Mutual Trust Microfinance Bank", code:"809" },
  { name:"Nirsal Microfinance Bank", code:"810" },
  { name:"Rehoboth Microfinance Bank", code:"811" },
  { name:"Seedvest Microfinance Bank", code:"812" },
  { name:"VFD Microfinance Bank", code:"813" },
  { name:"Kuda Bank", code:"900" },
  { name:"OPay", code:"901" },
  { name:"PalmPay", code:"902" },
  { name:"Moniepoint", code:"903" },
  { name:"9 Payment Service Bank", code:"904" },
  { name:"Rubies Bank", code:"905" },
  { name:"ALAT by Wema", code:"906" },
  { name:"Eyowo", code:"907" },
  { name:"Paga", code:"950" },
  { name:"Chipper Cash", code:"951" },
  { name:"Carbon", code:"952" },
  { name:"FairMoney", code:"953" },
  { name:"Branch", code:"954" }
];

/** State names, alphabetically. */
export const STATES = NIGERIA.map((entry) => entry.state);

/** Geopolitical zones. */
export const ZONES = [...new Set(NIGERIA.map((entry) => entry.zone))];

/** Every LGA under a state, or [] if the state is unknown. */
export function lgasFor(state) {
  const found = NIGERIA.find((entry) => entry.state === state);
  return found ? found.lgas : [];
}

/** Look up a bank's NIP code by name, or "" if unknown. */
export function bankCodeFor(name) {
  const found = BANKS.find((bank) => bank.name === name);
  return found ? found.code : "";
}
